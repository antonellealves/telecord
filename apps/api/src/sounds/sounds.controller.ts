import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  MAX_SOUND_UPLOAD_BYTES,
  soundLabelFromFilename,
  validateRoomId,
  validateSoundLabel,
  type RemoteSound,
} from '@telecord/shared';
import { CurrentUser, OptionalAuth, Public } from '../auth/auth.decorators';
import type { AccessClaims } from '../auth/tokens';
import { badRequest, payloadTooLarge, unsupportedMedia } from '../common/errors';
import { BodyTooLargeError, RawBodyUnavailableError, readRawBody } from '../common/raw-body';
import { actorOf, clientOf } from '../rooms/rooms.controller';
import type { Actor } from '../rooms/rooms.service';
import { SoundsService } from './sounds.service';

/**
 * Sons do soundboard.
 *
 * ## O envio não é multipart, e não é JSON
 *
 * O corpo são os bytes do arquivo, crus, e os metadados vão na query. Os dois
 * caminhos convencionais custam mais do que resolvem aqui: `multipart` traz um
 * parser inteiro como dependência para transportar um campo de texto e um
 * arquivo; JSON com base64 infla o arquivo em um terço e ainda obriga a subir
 * o teto do parser de JSON do serviço todo — o que abriria caminho para
 * mandarem 4 MB em qualquer outra rota.
 *
 * Como o `Content-Type` do envio não é `application/json`, o parser do Nest
 * nem toca no corpo, e ele chega intacto em `readRawBody`.
 */
@Controller('sounds')
export class SoundsController {
  constructor(private readonly sounds: SoundsService) {}

  @OptionalAuth()
  @Get()
  async list(
    @Query('room') room: string | undefined,
    @CurrentUser() claims: AccessClaims | undefined,
  ): Promise<{ sounds: RemoteSound[] }> {
    const slug = room === undefined || room === '' ? null : room;
    if (slug !== null) {
      const error = validateRoomId(slug);
      if (error !== null) throw badRequest('invalid_request', error);
    }
    return { sounds: await this.sounds.list(slug, viewerOf(claims)) };
  }

  /*
   * Teto de envios por minuto. Aqui não é só sobre requisições: cada uma
   * escreve até 2 MiB no cluster, e o Starter cobra armazenamento.
   */
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  @Post()
  async upload(
    @Query('room') room: string | undefined,
    @Query('filename') filename: string | undefined,
    @Query('label') label: string | undefined,
    @Query('emoji') emoji: string | undefined,
    @Query('durationMs') durationMs: string | undefined,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<RemoteSound> {
    const slug = room === undefined || room === '' ? null : room;
    if (slug !== null) {
      const error = validateRoomId(slug);
      if (error !== null) throw badRequest('invalid_request', error);
    }

    const chosen = label !== undefined && label !== '' ? label : soundLabelFromFilename(filename ?? '');
    const labelError = validateSoundLabel(chosen);
    if (labelError !== null) throw badRequest('invalid_request', labelError);

    const bytes = await this.readFile(request);

    return this.sounds.upload(
      {
        roomSlug: slug,
        label: chosen,
        emoji: readEmoji(emoji),
        durationMs: readDuration(durationMs),
        bytes,
      },
      actorOf(claims),
      clientOf(request),
    );
  }

  /**
   * O áudio em si.
   *
   * Pública, e o id é a única chave. É o mesmo modelo de acesso do resto do
   * produto — sala é alcançável por quem tem o endereço —, e fingir o
   * contrário aqui não protegeria nada: quem entra na sala já recebe a lista
   * inteira de sons dela.
   *
   * `immutable` porque o conteúdo de um id nunca muda: apagar cria um 404,
   * nunca um áudio diferente na mesma URL. É o que faz um clipe disparado
   * trinta vezes numa noite ser baixado uma.
   */
  @Public()
  @Get(':id/audio')
  async audio(
    @Param('id') id: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const sound = await this.sounds.audio(id);
    const etag = `"${sound.checksum}"`;

    response.setHeader('Content-Type', sound.mimeType);
    response.setHeader('ETag', etag);
    // Sobrescreve o `no-store` que o serviço aplica a toda resposta: aquele
    // existe para JSON com dado de gente, e isto é um arquivo imutável.
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    // O `nosniff` global já está posto; o tipo vem do farejador de bytes, não
    // do que quem enviou declarou.
    response.setHeader('Accept-Ranges', 'none');

    if (request.headers['if-none-match'] === etag) {
      response.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }

    response.setHeader('Content-Length', String(sound.bytes.byteLength));
    response.status(HttpStatus.OK).end(sound.bytes);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id') id: string,
    @CurrentUser() claims: AccessClaims | undefined,
    @Req() request: Request,
  ): Promise<void> {
    await this.sounds.remove(id, actorOf(claims), clientOf(request));
  }

  private async readFile(request: Request): Promise<Buffer> {
    try {
      return await readRawBody(request, MAX_SOUND_UPLOAD_BYTES);
    } catch (failure) {
      if (failure instanceof BodyTooLargeError) {
        throw payloadTooLarge(
          'file_too_large',
          `O arquivo passa de ${Math.floor(MAX_SOUND_UPLOAD_BYTES / 1024 / 1024)} MB.`,
        );
      }
      if (failure instanceof RawBodyUnavailableError) {
        // Alguém na frente consumiu o corpo. Não dá para reconstruir os bytes
        // de um arquivo a partir de um objeto já interpretado.
        throw unsupportedMedia(
          'body_consumed',
          'O arquivo não chegou inteiro. Mande com Content-Type de áudio ou application/octet-stream.',
        );
      }
      throw failure;
    }
  }
}

function viewerOf(claims: AccessClaims | undefined): Actor | null {
  return claims === undefined
    ? null
    : { id: claims.sub, displayName: claims.name, role: claims.role };
}

function readEmoji(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  const points = Array.from(value.trim());
  if (points.length > 3) throw badRequest('invalid_request', 'Use no máximo um emoji.');
  return points.join('');
}

/** Só enfeite, então valor estranho vira nulo em vez de erro. */
function readDuration(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 60 * 60 * 1000) return null;
  return Math.round(parsed);
}
