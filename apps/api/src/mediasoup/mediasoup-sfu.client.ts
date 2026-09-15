import { Inject, Injectable } from '@nestjs/common';
import type {
  MediasoupConnectTransportBody,
  MediasoupConsumeBody,
  MediasoupConsumeResult,
  MediasoupCreateTransportBody,
  MediasoupProduceBody,
  MediasoupProduceResult,
  MediasoupTransportInfo,
} from '@telecord/shared';
import { CONFIG, type AppConfig, type MediasoupConfig } from '../common/config';
import { serviceUnavailable } from '../common/errors';

const TIMEOUT_MS = 5_000;

/**
 * Cliente HTTP do processo mediasoup-sfu.
 *
 * Espelha o `CloudflareRealtimeClient` em forma: única porta de saída para o
 * processo, segredo interno nunca sai daqui, resposta validada na borda. A
 * diferença é QUEM está do outro lado — ali é a API pública da Cloudflare,
 * aqui é um processo NOSSO na VM Oracle, então a autenticação é um bearer
 * simples (`internalSecret`), não OAuth/App Token de terceiro.
 */
@Injectable()
export class MediasoupSfuClient {
  private readonly config: MediasoupConfig | null;

  constructor(@Inject(CONFIG) appConfig: AppConfig) {
    this.config = appConfig.mediasoup;
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  async routerRtpCapabilities(roomSlug: string): Promise<unknown> {
    return this.call('GET', `/rooms/${encodeURIComponent(roomSlug)}/rtp-capabilities`, undefined);
  }

  async createTransport(
    roomSlug: string,
    body: MediasoupCreateTransportBody,
  ): Promise<MediasoupTransportInfo> {
    return this.call('POST', `/rooms/${encodeURIComponent(roomSlug)}/transports`, body);
  }

  async connectTransport(
    roomSlug: string,
    transportId: string,
    body: MediasoupConnectTransportBody,
  ): Promise<void> {
    await this.call(
      'POST',
      `/rooms/${encodeURIComponent(roomSlug)}/transports/${encodeURIComponent(transportId)}/connect`,
      body,
    );
  }

  async produce(
    roomSlug: string,
    transportId: string,
    body: MediasoupProduceBody,
  ): Promise<MediasoupProduceResult> {
    return this.call(
      'POST',
      `/rooms/${encodeURIComponent(roomSlug)}/transports/${encodeURIComponent(transportId)}/produce`,
      body,
    );
  }

  async consume(
    roomSlug: string,
    transportId: string,
    body: MediasoupConsumeBody,
  ): Promise<MediasoupConsumeResult> {
    return this.call(
      'POST',
      `/rooms/${encodeURIComponent(roomSlug)}/transports/${encodeURIComponent(transportId)}/consume`,
      body,
    );
  }

  async resumeConsumer(roomSlug: string, consumerId: string, peerId: string): Promise<void> {
    await this.call(
      'POST',
      `/rooms/${encodeURIComponent(roomSlug)}/consumers/${encodeURIComponent(consumerId)}?action=resume`,
      { peerId },
    );
  }

  async publishedTracks(roomSlug: string, peerId: string): Promise<unknown> {
    return this.call(
      'GET',
      `/rooms/${encodeURIComponent(roomSlug)}/published?peerId=${encodeURIComponent(peerId)}`,
      undefined,
    );
  }

  async leave(roomSlug: string, peerId: string): Promise<void> {
    await this.call('POST', `/rooms/${encodeURIComponent(roomSlug)}/leave`, { peerId });
  }

  /**
   * Empurra mute/move para UM peer ao vivo pelo socket de presença — ver
   * `pushModerationCommand` em `apps/mediasoup-sfu/src/presence.ts`.
   * Best-effort: quem chama (`MediasoupModerationService`) já escreveu o
   * comando em `PeerPresence.adminCommand` ANTES desta chamada, que
   * continua sendo a fonte de verdade (ex.: alguém que reconectar lê de lá).
   * Isto só acelera quem já está com o socket aberto agora — por isso o erro
   * aqui não deveria derrubar a ação de moderação, só a entrega imediata.
   */
  async pushCommand(
    roomSlug: string,
    peerId: string,
    command: { forceMuted?: boolean; moveTo?: string | null },
  ): Promise<void> {
    await this.call('POST', `/rooms/${encodeURIComponent(roomSlug)}/peers/${encodeURIComponent(peerId)}/command`, command);
  }

  /** Quem está na sala agora, direto da memória do SFU — ver `RoomRegistry.listPresence`. Usado por `MediasoupModerationService.liveParticipants`. */
  async roomPresence(roomSlug: string): Promise<{ peerId: string; displayName: string; joinedAt: string }[]> {
    const result = await this.call<{ peers: { peerId: string; displayName: string; joinedAt: string }[] }>(
      'GET',
      `/rooms/${encodeURIComponent(roomSlug)}/presence`,
      undefined,
    );
    return result.peers;
  }

  /** Agregado de todas as salas com presença — usado por `MediasoupService.liveRooms`. */
  async liveRoomsPresence(): Promise<{ slug: string; participants: number; earliestJoinedAt: string }[]> {
    const result = await this.call<{ rooms: { slug: string; participants: number; earliestJoinedAt: string }[] }>(
      'GET',
      '/rooms/presence',
      undefined,
    );
    return result.rooms;
  }

  private requireConfig(): MediasoupConfig {
    if (this.config === null) {
      throw serviceUnavailable(
        'mediasoup_desligado',
        'A opção mediasoup não está configurada neste servidor.',
      );
    }
    return this.config;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body: object | undefined): Promise<T> {
    const config = this.requireConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${config.internalUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.internalSecret}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      throw serviceUnavailable('mediasoup_indisponivel', 'O servidor mediasoup não respondeu a tempo.');
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw serviceUnavailable('mediasoup_erro', `O servidor mediasoup respondeu ${response.status}.`);
    }

    try {
      return (await response.json()) as T;
    } catch {
      throw serviceUnavailable('mediasoup_resposta', 'Resposta ilegível do servidor mediasoup.');
    }
  }
}
