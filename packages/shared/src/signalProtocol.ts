/**
 * Protocolo do CANAL DE MÍDIA do transporte `mediasoup` — o que o navegador e
 * o `apps/mediasoup-sfu` falam por um WebSocket persistente em `/signal`.
 *
 * ## Por que existe, ao lado do canal de presença
 *
 * O desenho é o mesmo do Discord e do Meet: quem autoriza a entrada é um
 * serviço (aqui, `apps/api`, uma vez por entrada), e tudo o que decide se a
 * voz e a tela FUNCIONAM — criar transporte, publicar, assinar, retomar —
 * viaja por uma conexão aberta direto com o nó que encaminha a mídia. Antes
 * disto cada um desses passos era uma requisição HTTP que atravessava a
 * função serverless e o banco antes de chegar ao SFU: ligar o microfone
 * custava duas idas e voltas dessas em quem fala e mais duas em cada ouvinte.
 *
 * O canal de presença (`presenceProtocol.ts`, Socket.IO) continua com o que
 * é dele — roster, chat, moderação. Este aqui carrega só mídia, numa fila
 * única e ordenada: a resposta de um `consume` nunca chega depois do aviso de
 * que aquele consumer fechou.
 *
 * ## Formato
 *
 * Um quadro de texto do WebSocket = um JSON. Três tipos, com nomes de campo
 * curtos porque `speakers` trafega várias vezes por segundo numa sala falando:
 *
 * - `req`  cliente → servidor, com `id` crescente;
 * - `res`  servidor → cliente, com o MESMO `id`;
 * - `evt`  servidor → cliente, sem `id` — ninguém pediu.
 *
 * Nada aqui depende de DOM nem de Node, como o resto do pacote.
 */
import type { MediasoupTrackKind, MediasoupTransportInfo } from './index.js';
import type { PresenceTrackAnnounced, PresenceTrackClosed } from './presenceProtocol.js';

/** Caminho do WebSocket no processo mediasoup-sfu, ao lado de `/presence`. */
export const SIGNAL_PATH = '/signal';

/**
 * Versão do protocolo. O servidor recusa `identify` de versão que não conhece
 * — é o que permite mudar o formato sem que uma aba aberta há dias converse
 * torto com um SFU recém-publicado.
 */
export const SIGNAL_PROTOCOL_VERSION = 1;

/**
 * Teto de um quadro. Os maiores de verdade são `rtpParameters` (alguns KB) e
 * as RTP capabilities do Device (~10 KB); 256 KiB é o mesmo teto que as rotas
 * HTTP internas do SFU já aplicavam ao corpo.
 */
export const SIGNAL_MAX_FRAME_BYTES = 256 * 1024;

/**
 * Códigos de fechamento do WebSocket (faixa 4000-4999, reservada à aplicação).
 *
 * O cliente decide o que fazer SÓ pelo código: reconectar, pedir token novo ou
 * desistir. Texto de motivo é para log, não para lógica.
 */
export const SIGNAL_CLOSE = {
  /**
   * O próprio cliente derrubou a conexão para refazê-la (resposta que não
   * veio, por exemplo). Existe para NÃO ser confundido com 1000/1001, que o
   * servidor lê como "a pessoa saiu da sala".
   */
  clientRetry: 4000,
  /** Quadro malformado, tipo desconhecido, binário. Erro de programação. */
  protocolError: 4001,
  /** Token ausente, inválido ou vencido — peça outro a `apps/api` e volte. */
  unauthenticated: 4002,
  /** O mesmo par abriu outra conexão (outra aba). A mais nova vence; esta NÃO volta. */
  replaced: 4003,
  /** O servidor deixou de receber `pong` do navegador. */
  heartbeatTimeout: 4004,
  /** A fila de saída deste cliente estourou: ele não está lendo. */
  slowConsumer: 4005,
  /** O processo está reiniciando (deploy). Volte em instantes. */
  serverShutdown: 4006,
  /** A moderação removeu o par da sala. Reconectar desfaria a remoção: NÃO volta. */
  removed: 4007,
} as const;

export type SignalCloseCode = (typeof SIGNAL_CLOSE)[keyof typeof SIGNAL_CLOSE];

/** Fechamentos depois dos quais reconectar seria errado, não só inútil. */
export function isSignalCloseFinal(code: number): boolean {
  return code === SIGNAL_CLOSE.replaced || code === SIGNAL_CLOSE.removed;
}

// ---------------------------------------------------------------------------
// Pedidos e respostas
// ---------------------------------------------------------------------------

/** Quem está falando agora, medido pelo SFU no áudio que ele encaminha. */
export interface SignalSpeaker {
  peerId: string;
  /** dBov, de -127 (silêncio) a 0 (saturado). */
  volume: number;
}

/**
 * Resposta do `identify`: tudo o que o cliente precisa para montar — ou
 * RETOMAR — a sessão de mídia.
 */
export interface SignalReady {
  protocol: number;
  peerId: string;
  roomSlug: string;
  /**
   * Identidade da sessão de mídia DESTE par no servidor. Muda sempre que o
   * estado dele se perde (processo reiniciou, a folga de reconexão venceu,
   * outra aba assumiu). O cliente compara com a que conhecia: igual, os
   * transportes continuam valendo; diferente, refaz tudo do zero.
   */
  sessionId: string;
  /** RTP capabilities dos Routers — as mesmas em toda sala deste nó. */
  routerRtpCapabilities: unknown;
  /** De quanto em quanto tempo o cliente manda `ping`. */
  heartbeatIntervalMs: number;
  /** Token para a PRÓXIMA conexão; renovado a cada `ping`. Ver `presenceToken.ts`. */
  resumeToken: string;
  /** Tudo o que os OUTROS publicaram e continua no ar — retrato, não delta. */
  tracks: PresenceTrackAnnounced[];
  /**
   * O que o servidor ainda tem deste par — vazio em sessão nova. Numa
   * retomada é o que diz ao cliente o que se perdeu enquanto ele estava fora:
   * transporte que sumiu daqui obriga a refazer a sessão; producer ou consumer
   * que sumiu é republicado ou reassinado.
   */
  transportIds: string[];
  producerIds: string[];
  consumerIds: string[];
  speakers: SignalSpeaker[];
}

export interface SignalRequests {
  /**
   * Sempre o primeiro quadro. `sessionId` é a sessão que o cliente acha que
   * ainda tem. `instance` identifica a PÁGINA que abriu a conexão — o mesmo
   * valor vai no handshake do socket de presença, e é o que deixa o servidor
   * saber que os dois canais são da mesma página (ver `PeerLiveness` no SFU).
   */
  identify: { token: string; protocol: number; sessionId?: string | null; instance?: string };
  ping: Record<string, never>;
  /** Uma vez por sessão, depois de carregar o Device — evita mandar ~10 KB a cada `consume`. */
  setRtpCapabilities: { rtpCapabilities: unknown };
  createTransport: { direction: 'send' | 'recv' };
  connectTransport: { transportId: string; dtlsParameters: unknown };
  restartIce: { transportId: string };
  produce: {
    transportId: string;
    kind: 'audio' | 'video';
    rtpParameters: unknown;
    trackKind: MediasoupTrackKind;
  };
  closeProducer: { producerId: string };
  consume: { transportId: string; producerId: string };
  resumeConsumer: { consumerId: string };
  pauseConsumer: { consumerId: string };
}

export interface SignalResponses {
  identify: SignalReady;
  ping: { now: number; resumeToken: string };
  setRtpCapabilities: Record<string, never>;
  createTransport: MediasoupTransportInfo;
  connectTransport: Record<string, never>;
  restartIce: { iceParameters: unknown };
  produce: { producerId: string };
  closeProducer: Record<string, never>;
  consume: { id: string; producerId: string; kind: 'audio' | 'video'; rtpParameters: unknown };
  resumeConsumer: Record<string, never>;
  pauseConsumer: Record<string, never>;
}

export type SignalMethod = keyof SignalRequests;

export const SIGNAL_METHODS: readonly SignalMethod[] = [
  'identify',
  'ping',
  'setRtpCapabilities',
  'createTransport',
  'connectTransport',
  'restartIce',
  'produce',
  'closeProducer',
  'consume',
  'resumeConsumer',
  'pauseConsumer',
];

/**
 * `timeout` e `closed` nunca saem do servidor: é o cliente quem os fabrica
 * quando a resposta não vem. Ficam aqui para quem chama tratar um tipo só.
 */
export type SignalErrorCode =
  | 'bad_request'
  | 'unauthenticated'
  | 'not_found'
  | 'unsupported'
  | 'internal'
  | 'timeout'
  | 'closed';

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

export interface SignalEvents {
  'track:announced': PresenceTrackAnnounced;
  'track:closed': PresenceTrackClosed;
  /**
   * O consumer morreu do lado do servidor sem a track ter sido retirada do ar
   * — acontece quando a ponte entre dois Workers cai. Quem recebe assina de
   * novo; `track:closed` é que significa "acabou".
   */
  'consumer:closed': { consumerId: string; producerId: string };
  /** A lista INTEIRA de quem fala agora. Sobrescreve a anterior. */
  speakers: { speakers: SignalSpeaker[] };
}

export type SignalEventName = keyof SignalEvents;

// ---------------------------------------------------------------------------
// Quadros
// ---------------------------------------------------------------------------

export interface SignalRequestFrame<M extends SignalMethod = SignalMethod> {
  t: 'req';
  id: number;
  m: M;
  d: SignalRequests[M];
}

export interface SignalOkFrame {
  t: 'res';
  id: number;
  ok: true;
  d: unknown;
}

export interface SignalErrorFrame {
  t: 'res';
  id: number;
  ok: false;
  code: SignalErrorCode;
  message: string;
}

export type SignalResponseFrame = SignalOkFrame | SignalErrorFrame;

export interface SignalEventFrame<E extends SignalEventName = SignalEventName> {
  t: 'evt';
  e: E;
  d: SignalEvents[E];
}

export type SignalServerFrame = SignalResponseFrame | SignalEventFrame;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Confere o ENVELOPE de um pedido. O conteúdo de `d` é validado por quem
 * atende cada método — aqui só se garante que é um objeto, para ninguém
 * precisar testar `null` antes de ler um campo.
 */
export function parseSignalRequestFrame(raw: unknown): SignalRequestFrame | null {
  if (!isRecord(raw) || raw.t !== 'req' || !isRequestId(raw.id)) return null;
  if (typeof raw.m !== 'string' || !(SIGNAL_METHODS as readonly string[]).includes(raw.m)) {
    return null;
  }
  const data = raw.d === undefined ? {} : raw.d;
  if (!isRecord(data)) return null;
  return { t: 'req', id: raw.id, m: raw.m as SignalMethod, d: data as never };
}

/** O que o servidor mandou, do ponto de vista do navegador — entrada não confiável como qualquer outra. */
export function parseSignalServerFrame(raw: unknown): SignalServerFrame | null {
  if (!isRecord(raw)) return null;
  if (raw.t === 'res') {
    if (!isRequestId(raw.id)) return null;
    if (raw.ok === true) return { t: 'res', id: raw.id, ok: true, d: raw.d };
    if (raw.ok === false && typeof raw.code === 'string' && typeof raw.message === 'string') {
      return {
        t: 'res',
        id: raw.id,
        ok: false,
        code: raw.code as SignalErrorCode,
        message: raw.message,
      };
    }
    return null;
  }
  if (raw.t === 'evt' && typeof raw.e === 'string' && isRecord(raw.d)) {
    return { t: 'evt', e: raw.e as SignalEventName, d: raw.d as never };
  }
  return null;
}
