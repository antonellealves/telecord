import { Inject, Injectable } from '@nestjs/common';
import type {
  CfCloseBody,
  CfDataChannelsBody,
  CfDataChannelsResult,
  CfRenegotiateBody,
  CfSdp,
  CfSessionResult,
  CfSimpleResult,
  CfTracksBody,
  CfTracksResult,
} from '@telecord/shared';
import { CONFIG, type AppConfig, type CfSfuConfig } from '../common/config';
import { serviceUnavailable } from '../common/errors';

/** API HTTPS do Cloudflare Realtime SFU. Verificada na doc oficial (set/2026). */
const BASE_URL = 'https://rtc.live.cloudflare.com/v1/apps';

/** A doc exige `pc.connectionState === 'connected'` e trata timeout de 5 s. */
const TIMEOUT_MS = 5_000;

/**
 * Cliente HTTP do Cloudflare Realtime SFU.
 *
 * ## Única porta de saída para a Cloudflare
 *
 * Todas as chamadas ao SFU passam por aqui — o controller nunca monta uma
 * requisição HTTP à Cloudflare por conta própria. É o que mantém o `appToken`
 * num só lugar (nunca no cliente, SPEC do prompt) e a validação de resposta
 * numa só borda: daqui para dentro, os tipos são concretos, sem `any`.
 *
 * O SFU é pub/sub de Sessions e Tracks, sem conceito de sala. O roster e a
 * descoberta de tracks são do telecord; este cliente só fala o protocolo da
 * Cloudflare.
 */
@Injectable()
export class CloudflareRealtimeClient {
  private readonly config: CfSfuConfig | null;

  constructor(@Inject(CONFIG) appConfig: AppConfig) {
    this.config = appConfig.cfsfu;
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  /** `POST /sessions/new` → devolve o `sessionId`. */
  async createSession(): Promise<CfSessionResult> {
    return this.call('POST', '/sessions/new', undefined, isSessionResult);
  }

  /** `POST /sessions/:id/tracks/new` — empurra tracks locais ou puxa remotas. */
  async newTracks(sessionId: string, body: CfTracksBody): Promise<CfTracksResult> {
    return this.call(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/tracks/new`,
      body,
      isTracksResult,
    );
  }

  /** `PUT /sessions/:id/renegotiate` — envia a answer ao offer do SFU. */
  async renegotiate(sessionId: string, body: CfRenegotiateBody): Promise<CfSimpleResult> {
    return this.call(
      'PUT',
      `/sessions/${encodeURIComponent(sessionId)}/renegotiate`,
      body,
      isSimpleResult,
    );
  }

  /** `PUT /sessions/:id/tracks/close` — encerra tracks e renegocia o que sobrou. */
  async closeTracks(sessionId: string, body: CfCloseBody): Promise<CfTracksResult> {
    return this.call(
      'PUT',
      `/sessions/${encodeURIComponent(sessionId)}/tracks/close`,
      body,
      isTracksResult,
    );
  }

  /**
   * `POST /sessions/:id/datachannels/new` — endpoint PRÓPRIO, diferente de
   * tracks: é por aqui que chat e soundboard publicam/assinam um DataChannel
   * nomeado, nunca áudio/vídeo.
   */
  async newDataChannels(
    sessionId: string,
    body: CfDataChannelsBody,
  ): Promise<CfDataChannelsResult> {
    return this.call(
      'POST',
      `/sessions/${encodeURIComponent(sessionId)}/datachannels/new`,
      body,
      isDataChannelsResult,
    );
  }

  private requireConfig(): CfSfuConfig {
    if (this.config === null) {
      throw serviceUnavailable(
        'cfsfu_desligado',
        'A opção Cloudflare não está configurada neste servidor.',
      );
    }
    return this.config;
  }

  /**
   * Faz a chamada, com timeout, e valida a resposta na borda.
   *
   * O type guard `validate` é o que transforma o JSON opaco da rede num tipo
   * concreto: se a forma não bate, a função lança em vez de deixar um objeto
   * mal formado seguir para o resto do sistema.
   */
  private async call<T>(
    method: 'POST' | 'PUT',
    path: string,
    body: object | undefined,
    validate: (value: unknown) => value is T,
  ): Promise<T> {
    const config = this.requireConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/${config.appId}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.appToken}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // Timeout (abort) ou rede: para quem chamou é o mesmo — o SFU não veio.
      throw serviceUnavailable('cfsfu_indisponivel', 'O Cloudflare Realtime não respondeu a tempo.');
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw serviceUnavailable(
        'cfsfu_erro',
        `O Cloudflare Realtime respondeu ${response.status}.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw serviceUnavailable('cfsfu_resposta', 'Resposta ilegível do Cloudflare Realtime.');
    }

    // A Cloudflare devolve 200 com `errorCode` em algumas falhas de negociação.
    if (isRecord(parsed) && typeof parsed.errorCode === 'string') {
      const description =
        typeof parsed.errorDescription === 'string' ? parsed.errorDescription : parsed.errorCode;
      throw serviceUnavailable('cfsfu_erro', `Cloudflare Realtime: ${description}`);
    }

    if (!validate(parsed)) {
      throw serviceUnavailable('cfsfu_resposta', 'Resposta inesperada do Cloudflare Realtime.');
    }
    return parsed;
  }
}

// ---------------------------------------------------------------------------
// Validação de resposta (a borda onde o `unknown` da rede vira tipo concreto)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isSdp(value: unknown): value is CfSdp {
  return isRecord(value) && (value.type === 'offer' || value.type === 'answer') && typeof value.sdp === 'string';
}

function isSessionResult(value: unknown): value is CfSessionResult {
  return isRecord(value) && typeof value.sessionId === 'string';
}

function isTracksResult(value: unknown): value is CfTracksResult {
  return (
    isRecord(value) &&
    typeof value.requiresImmediateRenegotiation === 'boolean' &&
    Array.isArray(value.tracks)
  );
}

function isSimpleResult(value: unknown): value is CfSimpleResult {
  // Sucesso vem como corpo vazio; erro já foi tratado por `errorCode` acima.
  return isRecord(value);
}

function isDataChannelsResult(value: unknown): value is CfDataChannelsResult {
  return isRecord(value) && Array.isArray(value.dataChannels);
}
