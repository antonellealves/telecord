/**
 * Apoio dos testes de integração: um nó de verdade (Worker do mediasoup
 * incluído) numa porta sorteada, e um cliente mínimo do canal de mídia.
 *
 * Nada aqui simula o servidor. O que os testes exercitam é o mesmo
 * `startNode` que `main.ts` sobe em produção — a única coisa fabricada são os
 * parâmetros de mídia, já que não há navegador para gerá-los.
 */
import { WebSocket } from 'ws';
import {
  SIGNAL_PATH,
  SIGNAL_PROTOCOL_VERSION,
  signPresenceToken,
  type SignalEventFrame,
  type SignalEventName,
  type SignalEvents,
  type SignalMethod,
  type SignalReady,
  type SignalRequests,
  type SignalResponses,
  type SignalServerFrame,
} from '@telecord/shared';
import type { SfuConfig } from '../src/config';
import { startNode, type SfuNode } from '../src/node';

export const SECRET = 'segredo-de-teste-bem-longo-o-suficiente';

/**
 * `portBase` separa os arquivos de teste, que o `node --test` roda em
 * processos paralelos: cada um precisa da própria faixa de portas de mídia.
 */
export function testConfig(portBase: number, overrides: Partial<SfuConfig> = {}): SfuConfig {
  return {
    port: 0,
    internalSecret: SECRET,
    announcedIp: '127.0.0.1',
    listenIp: '127.0.0.1',
    rtcMinPort: portBase,
    rtcMaxPort: portBase + 9,
    workers: 1,
    workerCapacity: 500,
    pipeMinPort: portBase + 100,
    pipeMaxPort: portBase + 199,
    heartbeatIntervalMs: 15_000,
    resumeGraceMs: 10_000,
    ...overrides,
  };
}

export async function startTestNode(portBase: number, overrides: Partial<SfuConfig> = {}): Promise<SfuNode> {
  return startNode(testConfig(portBase, overrides), {
    onWorkerDied: (index) => {
      throw new Error(`Worker ${index} morreu durante o teste`);
    },
    log: () => undefined,
  });
}

export function tokenFor(roomSlug: string, peerId: string, ttlMs = 60_000): Promise<string> {
  return signPresenceToken({ peerId, roomSlug, displayName: `Nome de ${peerId}`, secret: SECRET, ttlMs });
}

export class RequestFailed extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Closed {
  code: number;
  reason: string;
}

/** Cliente do canal de mídia reduzido ao osso: pedido, resposta, eventos e o código de fechamento. */
export class TestClient {
  readonly events: SignalEventFrame[] = [];
  readonly closed: Promise<Closed>;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly waiters = new Set<() => void>();

  private constructor(readonly ws: WebSocket) {
    this.closed = new Promise((resolve) => {
      ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const frame = JSON.parse(data.toString()) as SignalServerFrame;
      if (frame.t === 'evt') {
        this.events.push(frame);
        for (const wake of this.waiters) wake();
        return;
      }
      const entry = this.pending.get(frame.id);
      if (entry === undefined) return;
      this.pending.delete(frame.id);
      if (frame.ok) entry.resolve(frame.d);
      else entry.reject(new RequestFailed(frame.code, frame.message));
    });
    ws.once('close', () => {
      for (const entry of this.pending.values()) entry.reject(new RequestFailed('closed', 'conexão fechada'));
      this.pending.clear();
      for (const wake of this.waiters) wake();
    });
  }

  static connect(port: number, options: { autoPong?: boolean } = {}): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${SIGNAL_PATH}`, { autoPong: options.autoPong ?? true });
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(new TestClient(ws)));
      ws.once('error', reject);
    });
  }

  /** Conecta e se identifica — o caminho feliz de quase todo teste. */
  static async join(
    port: number,
    roomSlug: string,
    peerId: string,
    sessionId: string | null = null,
  ): Promise<{ client: TestClient; ready: SignalReady }> {
    const client = await TestClient.connect(port);
    const ready = await client.request('identify', {
      token: await tokenFor(roomSlug, peerId),
      protocol: SIGNAL_PROTOCOL_VERSION,
      sessionId,
    });
    return { client, ready };
  }

  request<M extends SignalMethod>(method: M, data: SignalRequests[M]): Promise<SignalResponses[M]> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<SignalResponses[M]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.ws.send(JSON.stringify({ t: 'req', id, m: method, d: data }));
    });
  }

  sendRaw(text: string | Buffer): void {
    this.ws.send(text);
  }

  /** Espera um evento que satisfaça `match` — já recebido ou por chegar. */
  async waitEvent<E extends SignalEventName>(
    name: E,
    match: (data: SignalEvents[E]) => boolean = () => true,
    timeoutMs = 3_000,
  ): Promise<SignalEvents[E]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find((frame) => frame.e === name && match(frame.d as SignalEvents[E]));
      if (found !== undefined) return found.d as SignalEvents[E];
      const remaining = deadline - Date.now();
      if (remaining <= 0 || this.ws.readyState === WebSocket.CLOSED) {
        throw new Error(`evento '${name}' não chegou em ${timeoutMs} ms`);
      }
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, remaining);
        this.waiters.add(wake);
      });
    }
  }

  hasEvent<E extends SignalEventName>(name: E, match: (data: SignalEvents[E]) => boolean = () => true): boolean {
    return this.events.some((frame) => frame.e === name && match(frame.d as SignalEvents[E]));
  }

  /** Despedida: é como o navegador fecha ao sair da sala. */
  leave(): Promise<Closed> {
    this.ws.close(1000);
    return this.closed;
  }

  /** Queda: o socket some sem quadro de fechamento, como numa rede que caiu. */
  drop(): Promise<Closed> {
    this.ws.terminate();
    return this.closed;
  }
}

/** DTLS de mentira: o mediasoup só guarda a impressão digital até o handshake, que aqui nunca acontece. */
export const FAKE_DTLS = {
  role: 'client',
  fingerprints: [
    {
      algorithm: 'sha-256',
      value:
        '82:5A:68:3D:36:C3:0A:DE:AF:E7:32:43:D2:88:83:57:AC:2D:65:E5:80:C4:B6:FB:AF:1A:A0:21:9F:6D:0C:AD',
    },
  ],
};

let nextSsrc = 10_000_000;
let nextMid = 0;

/** Parâmetros de um microfone Opus, com `mid` e `ssrc` novos a cada chamada como um navegador faria. */
export function opusParameters(): unknown {
  nextSsrc += 1;
  nextMid += 1;
  return {
    mid: `a${nextMid}`,
    codecs: [
      {
        mimeType: 'audio/opus',
        payloadType: 111,
        clockRate: 48000,
        channels: 2,
        parameters: { useinbandfec: 1 },
        rtcpFeedback: [],
      },
    ],
    headerExtensions: [],
    encodings: [{ ssrc: nextSsrc }],
    rtcp: { cname: 'teste' },
  };
}

export function vp8Parameters(): unknown {
  nextSsrc += 1;
  nextMid += 1;
  return {
    mid: `v${nextMid}`,
    codecs: [
      {
        mimeType: 'video/VP8',
        payloadType: 96,
        clockRate: 90000,
        parameters: {},
        rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }],
      },
    ],
    headerExtensions: [],
    encodings: [{ ssrc: nextSsrc }],
    rtcp: { cname: 'teste' },
  };
}

/** Monta os dois transportes de um par e registra as capabilities — o que o cliente faz logo depois do `identify`. */
export async function setUpTransports(
  client: TestClient,
  ready: SignalReady,
): Promise<{ sendId: string; recvId: string }> {
  await client.request('setRtpCapabilities', { rtpCapabilities: ready.routerRtpCapabilities });
  const [send, recv] = await Promise.all([
    client.request('createTransport', { direction: 'send' }),
    client.request('createTransport', { direction: 'recv' }),
  ]);
  await client.request('connectTransport', { transportId: send.id, dtlsParameters: FAKE_DTLS });
  await client.request('connectTransport', { transportId: recv.id, dtlsParameters: FAKE_DTLS });
  return { sendId: send.id, recvId: recv.id };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Espera uma condição ficar verdadeira, sem um `sleep` de duração chutada. */
export async function until(condition: () => boolean, timeoutMs = 3_000, what = 'condição'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} não ficou verdadeira em ${timeoutMs} ms`);
    await delay(10);
  }
}
