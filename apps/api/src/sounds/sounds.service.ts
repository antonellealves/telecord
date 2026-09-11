import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Sound } from '../generated/prisma';
import {
  MAX_SOUND_UPLOAD_BYTES,
  normalizeDisplayName,
  normalizeRoomId,
  type RemoteSound,
  type SoundMimeType,
} from '@telecord/shared';
import { CONFIG, type AppConfig } from '../common/config';
import { forbidden, notFound, payloadTooLarge, unsupportedMedia } from '../common/errors';
import { LogService, type LogClient } from '../logging/log.service';
import { PrismaService } from '../prisma/prisma.service';
import { RoomsService, type Actor } from '../rooms/rooms.service';
import { sniffAudioMime } from './sound-format';

/** Quantos sons uma sala pode ter. Painel maior que isso não se lê. */
const MAX_SOUNDS_PER_ROOM = 120;

export interface UploadInput {
  roomSlug: string | null;
  label: string;
  emoji: string | null;
  durationMs: number | null;
  bytes: Buffer;
}

/**
 * Soundboard enviado.
 *
 * ## Onde os bytes moram
 *
 * No TiDB, numa tabela só deles (`SoundBlob`). A alternativa seria
 * armazenamento de objeto, que é o certo em escala — e é justamente por isso
 * que o metadado está separado dos bytes: trocar significa substituir uma
 * tabela por uma chave, sem tocar em `Sound`, que é o que todo o resto
 * referencia.
 *
 * Para o tamanho deste produto o banco ganha por não acrescentar fornecedor,
 * credencial nem um segundo lugar de onde as coisas podem sumir. O teto de
 * 2 MiB por arquivo é o que mantém isso honesto.
 *
 * ## Quem pode o quê
 *
 * Enviar para uma sala: qualquer pessoa com conta. É um soundboard de turma, e
 * exigir cargo para acrescentar um clipe mataria o recurso.
 *
 * Apagar: quem enviou, quem administra a sala, ou um administrador global.
 * Som GLOBAL (sem sala) só administrador instala — ele aparece em toda sala do
 * sistema, e isso é decisão de quem opera, não de quem passa.
 */
@Injectable()
export class SoundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rooms: RoomsService,
    private readonly log: LogService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Sons visíveis numa sala: os globais mais os dela.
   *
   * Sem sala, só os globais — é o que a tela inicial mostraria, e o que sobra
   * quando alguém abre o painel antes de o slug existir.
   */
  async list(roomSlug: string | null, viewer: Actor | null): Promise<RemoteSound[]> {
    const room =
      roomSlug === null
        ? null
        : await this.prisma.room.findFirst({
            where: { slug: normalizeRoomId(roomSlug), deletedAt: null },
            select: { id: true, ownerId: true, slug: true },
          });

    const rows = await this.prisma.sound.findMany({
      where: {
        deletedAt: null,
        OR: [{ roomId: null }, ...(room === null ? [] : [{ roomId: room.id }])],
      },
      include: { uploadedBy: { select: { id: true, displayName: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_SOUNDS_PER_ROOM + 40,
    });

    // Um acesso ao banco para o papel, não um por som.
    const role = room === null ? null : await this.rooms.roleOf(room.id, viewer?.id ?? null);
    const managesRoom =
      viewer !== null && (viewer.role === 'ADMIN' || room?.ownerId === viewer.id || role === 'OWNER' || role === 'MOD');

    return rows.map((row) => this.toRemote(row, room?.slug ?? null, viewer, managesRoom));
  }

  async upload(input: UploadInput, actor: Actor, client: LogClient): Promise<RemoteSound> {
    if (input.bytes.byteLength === 0) {
      throw unsupportedMedia('empty_file', 'O arquivo chegou vazio.');
    }
    if (input.bytes.byteLength > MAX_SOUND_UPLOAD_BYTES) {
      throw payloadTooLarge(
        'file_too_large',
        `O arquivo passa de ${Math.floor(MAX_SOUND_UPLOAD_BYTES / 1024 / 1024)} MB.`,
      );
    }

    const mimeType = sniffAudioMime(input.bytes);
    if (mimeType === null) {
      throw unsupportedMedia(
        'not_audio',
        'Não reconheci este arquivo como áudio. Use mp3, ogg, wav, m4a, flac, aac ou webm.',
      );
    }

    if (input.roomSlug === null && actor.role !== 'ADMIN') {
      throw forbidden(
        'global_sound_admin_only',
        'Som para todas as salas só um administrador instala. Escolha uma sala.',
      );
    }

    const room =
      input.roomSlug === null ? null : await this.rooms.ensureRoom(input.roomSlug, actor, client);

    const checksum = createHash('sha256').update(input.bytes).digest('hex');

    /*
     * Mesmo arquivo, mesma sala: devolve o que já existe.
     *
     * Sem isto, o segundo clique no botão de enviar — ou dois arquivos com
     * nomes diferentes e conteúdo igual — guardaria os bytes de novo e
     * encheria o painel de cards que tocam a mesma coisa.
     */
    const twin = await this.prisma.sound.findFirst({
      where: { roomId: room?.id ?? null, checksum, deletedAt: null },
      include: { uploadedBy: { select: { id: true, displayName: true } } },
    });
    if (twin !== null) {
      return this.toRemote(twin, room?.slug ?? null, actor, true);
    }

    if (room !== null) {
      const count = await this.prisma.sound.count({
        where: { roomId: room.id, deletedAt: null },
      });
      if (count >= MAX_SOUNDS_PER_ROOM) {
        throw forbidden(
          'room_sound_limit',
          `Esta sala chegou ao limite de ${MAX_SOUNDS_PER_ROOM} sons. Apague algum antes.`,
        );
      }
    }

    const created = await this.prisma.$transaction(async (tx) => {
      const sound = await tx.sound.create({
        data: {
          roomId: room?.id ?? null,
          uploadedById: actor.id,
          label: normalizeDisplayName(input.label),
          emoji: input.emoji,
          mimeType,
          byteSize: input.bytes.byteLength,
          durationMs: input.durationMs,
          checksum,
        },
        include: { uploadedBy: { select: { id: true, displayName: true } } },
      });
      // Metadado e bytes na MESMA transação: um `Sound` sem `SoundBlob` seria
      // um card que aparece no painel e não toca em ninguém.
      // `Uint8Array` e não `Buffer`: o tipo de `Bytes` do Prisma exige um
      // buffer não compartilhado, e `Buffer` pode estar sobre um
      // `SharedArrayBuffer`. A cópia é rasa e o conteúdo é o mesmo.
      await tx.soundBlob.create({
        data: { soundId: sound.id, data: new Uint8Array(input.bytes) },
      });
      return sound;
    });

    if (room !== null) {
      await this.rooms.joinAsMember(room.id, actor.id);
    }

    await this.log.record({
      level: 'INFO',
      scope: 'sounds',
      event: 'sound.upload',
      message: `som "${created.label}" enviado`,
      userId: actor.id,
      roomSlug: room?.slug,
      context: { mimeType, byteSize: created.byteSize },
      client,
    });
    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'sound.upload',
      targetType: 'sound',
      targetId: created.id,
      summary: `enviou "${created.label}" para ${room?.slug ?? 'todas as salas'}`,
      after: { label: created.label, mimeType, byteSize: created.byteSize },
      client,
    });

    return this.toRemote(created, room?.slug ?? null, actor, true);
  }

  async remove(id: string, actor: Actor, client: LogClient): Promise<void> {
    const sound = await this.prisma.sound.findFirst({
      where: { id, deletedAt: null },
      include: { room: { select: { id: true, slug: true, ownerId: true } } },
    });
    if (sound === null) {
      throw notFound('sound_not_found', 'Este som não existe mais.');
    }

    await this.assertCanDelete(sound, actor);

    /*
     * Metadado fica com `deletedAt`; os bytes vão embora de vez.
     *
     * A linha de `Sound` é o que amarra a auditoria — sem ela, "fulano apagou
     * o som X" apontaria para o nada. Os megabytes é que não têm por que
     * continuar ocupando o cluster depois que ninguém mais os toca.
     */
    await this.prisma.$transaction(async (tx) => {
      await tx.sound.update({ where: { id: sound.id }, data: { deletedAt: new Date() } });
      await tx.soundBlob.deleteMany({ where: { soundId: sound.id } });
    });

    await this.log.audit({
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: 'sound.delete',
      targetType: 'sound',
      targetId: sound.id,
      summary: `apagou "${sound.label}" de ${sound.room?.slug ?? 'todas as salas'}`,
      before: { label: sound.label, byteSize: sound.byteSize },
      client,
    });
  }

  /** Os bytes, para a rota que serve o áudio. */
  async audio(id: string): Promise<{ bytes: Buffer; mimeType: string; checksum: string }> {
    const sound = await this.prisma.sound.findFirst({
      where: { id, deletedAt: null },
      select: { mimeType: true, checksum: true, blob: { select: { data: true } } },
    });
    if (sound === null || sound.blob === null) {
      throw notFound('sound_not_found', 'Este som não existe mais.');
    }
    return {
      bytes: Buffer.from(sound.blob.data),
      mimeType: sound.mimeType,
      checksum: sound.checksum,
    };
  }

  // -------------------------------------------------------------------------

  private async assertCanDelete(
    sound: Sound & { room: { id: string; ownerId: string | null } | null },
    actor: Actor,
  ): Promise<void> {
    if (actor.role === 'ADMIN') return;
    if (sound.uploadedById === actor.id) return;
    if (sound.room === null) {
      // Som global sem ser dono dele: só administrador.
      throw forbidden('forbidden', 'Só um administrador apaga um som global.');
    }
    if (sound.room.ownerId === actor.id) return;

    const role = await this.rooms.roleOf(sound.room.id, actor.id);
    if (role !== 'OWNER' && role !== 'MOD') {
      throw forbidden('forbidden', 'Este som não é seu, e você não administra esta sala.');
    }
  }

  /**
   * A URL do áudio é ABSOLUTA, montada a partir da `API_URL`.
   *
   * Em produção app e API dividem a origem e um caminho relativo bastaria; em
   * desenvolvimento não — o Vite está em :5173 e a API em :3000, e um
   * `/api/sounds/…` relativo bateria no Vite, que não tem o arquivo. Montar
   * daqui faz o mesmo JSON servir os dois ambientes.
   */
  private toRemote(
    sound: Sound & { uploadedBy?: { id: string; displayName: string } | null },
    roomSlug: string | null,
    viewer: Actor | null,
    managesRoom: boolean,
  ): RemoteSound {
    const canDelete =
      viewer !== null &&
      (viewer.role === 'ADMIN' ||
        sound.uploadedById === viewer.id ||
        (sound.roomId !== null && managesRoom));

    return {
      id: sound.id,
      label: sound.label,
      emoji: sound.emoji,
      url: `${this.config.apiUrl}/sounds/${sound.id}/audio`,
      mimeType: sound.mimeType as SoundMimeType,
      byteSize: sound.byteSize,
      durationMs: sound.durationMs,
      roomSlug: sound.roomId === null ? null : roomSlug,
      uploadedBy: sound.uploadedBy ?? null,
      createdAt: sound.createdAt.toISOString(),
      canDelete,
    };
  }
}
