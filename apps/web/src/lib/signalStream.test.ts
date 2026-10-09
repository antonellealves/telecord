/**
 * O canal de mídia do lado do navegador: o que ele faz quando a conexão cai.
 *
 * O caminho feliz é exercitado de verdade contra o SFU (ver os testes de
 * integração em `apps/mediasoup-sfu`). Aqui ficam as decisões que só
 * aparecem quando algo dá errado, e que erram em silêncio:
 *
 * - desistir cedo demais deixa a pessoa no caminho HTTP antigo sem motivo;
 * - insistir quando não devia desfaz uma remoção da moderação;
 * - voltar com o token errado nunca volta.
 *
 * O WebSocket é de mentira e o relógio também: nenhum teste espera tempo real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNAL_CLOSE, SIGNAL_PROTOCOL_VERSION, type SignalReady } from '@telecord/shared';
import {
  backoffDelay,
  SignalRequestFailed,
  SignalStream,
  SignalUnavailable,
  signalUrl,
  type SignalStreamState,
} from './signalStream';

interface SentFrame {
  t: 'req';
  id: number;
  m: string;
  d: Record<string, unknown>;
}

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  readonly sent: SentFrame[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentFrame);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.onclose?.({ code: code ?? 1005, reason: reason ?? '' });
  }

  /** O servidor aceitou a conexão. */
  accept(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** A conexão caiu, com o código que o servidor (ou a rede) deu. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: '' });
  }

  get lastRequest(): SentFrame {
    const frame = this.sent.at(-1);
    if (frame === undefined) throw new Error('nenhum quadro enviado');
    return frame;
  }
}

function readyPayload(overrides: Partial<SignalReady> = {}): SignalReady {
  return {
    protocol: SIGNAL_PROTOCOL_VERSION,
    peerId: 'ana',
    roomSlug: 'sala',
    sessionId: 'sessao-1',
    routerRtpCapabilities: {},
    heartbeatIntervalMs: 15_000,
    resumeToken: 'token-de-retomada-1',
    tracks: [],
    transportIds: [],
    producerIds: [],
    consumerIds: [],
    speakers: [],
    ...overrides,
  };
}

interface Harness {
  stream: SignalStream;
  states: SignalStreamState[];
  readies: { ready: SignalReady; reconnected: boolean }[];
  events: { name: string; data: unknown }[];
  finalCloses: number[];
  tokenRequests: boolean[];
  sessionId: { current: string | null };
  /** O WebSocket mais recente que o canal abriu. */
  socket: () => FakeSocket;
  /** Aceita a conexão atual e responde ao `identify` com `ready`. */
  becomeReady: (overrides?: Partial<SignalReady>) => Promise<void>;
}

function harness(): Harness {
  FakeSocket.instances = [];
  const states: SignalStreamState[] = [];
  const readies: Harness['readies'] = [];
  const events: Harness['events'] = [];
  const finalCloses: number[] = [];
  const tokenRequests: boolean[] = [];
  const sessionId = { current: null as string | null };

  const stream = new SignalStream({
    nodeUrl: 'https://ms.exemplo',
    getToken: (fresh) => {
      tokenRequests.push(fresh);
      return Promise.resolve(fresh ? 'token-novo-da-api' : 'token-de-entrada');
    },
    getSessionId: () => sessionId.current,
    instanceId: 'pagina-1',
    onReady: (ready, reconnected) => {
      sessionId.current = ready.sessionId;
      readies.push({ ready, reconnected });
    },
    onEvent: (name, data) => events.push({ name, data }),
    onStateChange: (state) => states.push(state),
    onFinalClose: (code) => finalCloses.push(code),
    WebSocketCtor: FakeSocket as unknown as typeof WebSocket,
  });

  const socket = (): FakeSocket => {
    const last = FakeSocket.instances.at(-1);
    if (last === undefined) throw new Error('nenhum WebSocket aberto');
    return last;
  };
  const becomeReady = async (overrides: Partial<SignalReady> = {}): Promise<void> => {
    const current = socket();
    current.accept();
    // O `identify` espera o token: uma volta de microtarefas.
    await vi.advanceTimersByTimeAsync(0);
    current.receive({ t: 'res', id: current.lastRequest.id, ok: true, d: readyPayload(overrides) });
  };

  return { stream, states, readies, events, finalCloses, tokenRequests, sessionId, socket, becomeReady };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('endereço e espera', () => {
  it('troca http(s) por ws(s) e acrescenta o caminho do canal', () => {
    expect(signalUrl('https://ms-1.exemplo')).toBe('wss://ms-1.exemplo/signal');
    expect(signalUrl('http://localhost:3100/')).toBe('ws://localhost:3100/signal');
  });

  it('a espera entre tentativas dobra até o teto, com sorteio só para baixo', () => {
    const cheio = (attempt: number): number => backoffDelay(attempt, () => 1);
    expect([0, 1, 2, 3, 4].map(cheio)).toEqual([300, 600, 1200, 2400, 4800]);
    expect(cheio(10)).toBe(8000);
    expect(backoffDelay(0, () => 0)).toBe(210);
  });
});

describe('abrir o canal', () => {
  it('conecta, se identifica com o token de entrada e fica pronto', async () => {
    const h = harness();
    const started = h.stream.start();
    expect(h.socket().url).toBe('wss://ms.exemplo/signal');

    await h.becomeReady();
    const ready = await started;

    expect(h.socket().sent[0]).toMatchObject({
      m: 'identify',
      d: { token: 'token-de-entrada', protocol: SIGNAL_PROTOCOL_VERSION, sessionId: null, instance: 'pagina-1' },
    });
    expect(ready.sessionId).toBe('sessao-1');
    expect(h.readies).toEqual([{ ready, reconnected: false }]);
    expect(h.states).toEqual(['ready']);
    expect(h.tokenRequests).toEqual([false]);
  });

  it('casa cada resposta com o pedido dela, e erro do servidor vira rejeição com o código', async () => {
    const h = harness();
    void h.stream.start();
    await h.becomeReady();

    const primeiro = h.stream.request('createTransport', { direction: 'send' });
    const segundo = h.stream.request('consume', { transportId: 't', producerId: 'p' });
    await vi.advanceTimersByTimeAsync(0);
    const [reqA, reqB] = h.socket().sent.slice(-2) as [SentFrame, SentFrame];

    // Respostas fora de ordem: quem manda é o `id`.
    h.socket().receive({ t: 'res', id: reqB.id, ok: false, code: 'not_found', message: 'não existe' });
    h.socket().receive({ t: 'res', id: reqA.id, ok: true, d: { id: 'transporte-1' } });

    await expect(primeiro).resolves.toEqual({ id: 'transporte-1' });
    await expect(segundo).rejects.toMatchObject({ name: 'SignalRequestFailed', code: 'not_found' });
  });

  it('pedido sem resposta vence o prazo em vez de ficar pendurado', async () => {
    const h = harness();
    void h.stream.start();
    await h.becomeReady();

    const pedido = h.stream.request('resumeConsumer', { consumerId: 'c' }, 1_000);
    const falhou = expect(pedido).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1_001);
    await falhou;
  });

  it('entrega eventos depois do ready, e ignora o que não entende', async () => {
    const h = harness();
    void h.stream.start();
    h.socket().accept();
    await vi.advanceTimersByTimeAsync(0);

    // Antes do `ready` não há retrato com que conferir: fica de fora.
    h.socket().receive({ t: 'evt', e: 'speakers', d: { speakers: [] } });
    h.socket().receive({ t: 'res', id: h.socket().lastRequest.id, ok: true, d: readyPayload() });
    h.socket().receive({ t: 'evt', e: 'track:closed', d: { roomSlug: 'sala', peerId: 'bia', producerId: 'p1' } });
    h.socket().receive('isto não é um quadro');
    h.socket().receive({ t: 'coisa-nova' });

    expect(h.events).toEqual([
      { name: 'track:closed', data: { roomSlug: 'sala', peerId: 'bia', producerId: 'p1' } },
    ]);
  });
});

describe('antes de ficar pronto pela primeira vez', () => {
  it('duas tentativas e desiste — é o sinal para usar o caminho HTTP', async () => {
    const h = harness();
    const started = h.stream.start();
    const falhou = expect(started).rejects.toBeInstanceOf(SignalUnavailable);

    h.socket().drop();
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeSocket.instances).toHaveLength(2);
    h.socket().drop();
    await falhou;

    // Desistiu de vez: nada de terceira tentativa em segundo plano.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(h.states.at(-1)).toBe('closed');
  });

  it('servidor que aceita e nunca responde não segura a entrada para sempre', async () => {
    const h = harness();
    const started = h.stream.start();
    const falhou = expect(started).rejects.toBeInstanceOf(SignalUnavailable);

    // A primeira abre, manda o `identify` e fica sem resposta até o prazo.
    h.socket().accept();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(FakeSocket.instances[0]?.closedWith?.code).toBe(SIGNAL_CLOSE.clientRetry);

    // A segunda também.
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeSocket.instances).toHaveLength(2);
    h.socket().accept();
    await vi.advanceTimersByTimeAsync(6_000);
    await falhou;
  });

  it('nó que fala outra versão do protocolo: desiste na hora, sem segunda tentativa', async () => {
    const h = harness();
    const started = h.stream.start();
    const falhou = expect(started).rejects.toBeInstanceOf(SignalUnavailable);
    h.socket().accept();
    await vi.advanceTimersByTimeAsync(0);
    h.socket().receive({
      t: 'res',
      id: h.socket().lastRequest.id,
      ok: false,
      code: 'unsupported',
      message: 'versão desconhecida',
    });
    await falhou;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('token recusado na primeira: tenta de novo com um token NOVO da API', async () => {
    const h = harness();
    const started = h.stream.start();
    h.socket().accept();
    await vi.advanceTimersByTimeAsync(0);
    h.socket().drop(SIGNAL_CLOSE.unauthenticated);

    await vi.advanceTimersByTimeAsync(300);
    await h.becomeReady();
    await started;
    expect(h.tokenRequests).toEqual([false, true]);
    expect(h.socket().sent[0]?.d.token).toBe('token-novo-da-api');
  });
});

describe('depois de pronto, a queda vira volta', () => {
  it('reconecta sozinho, com o token que o servidor deu e a sessão que conhecia', async () => {
    const h = harness();
    void h.stream.start();
    await h.becomeReady();

    h.socket().drop();
    expect(h.states.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeSocket.instances).toHaveLength(2);

    await h.becomeReady({ resumeToken: 'token-de-retomada-2' });
    expect(h.socket().sent[0]).toMatchObject({
      m: 'identify',
      d: { token: 'token-de-retomada-1', sessionId: 'sessao-1' },
    });
    expect(h.readies.at(-1)?.reconnected).toBe(true);
    expect(h.states).toEqual(['ready', 'reconnecting', 'ready']);
    // `apps/api` não foi consultada de novo: o token veio do próprio SFU.
    expect(h.tokenRequests).toEqual([false]);
  });

  it('insiste, espaçando as tentativas, enquanto o servidor não volta', async () => {
    const h = harness();
    void h.stream.start();
    await h.becomeReady();
    vi.spyOn(Math, 'random').mockReturnValue(1);

    h.socket().drop();
    for (const espera of [300, 600, 1_200, 2_400]) {
      await vi.advanceTimersByTimeAsync(espera - 1);
      const antes = FakeSocket.instances.length;
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.instances).toHaveLength(antes + 1);
      h.socket().drop();
    }
    vi.restoreAllMocks();
  });

  it('token de retomada velho demais: pede um novo à API em vez de arriscar', async () => {
    const h = harness();
    void h.stream.start();
    await h.becomeReady();

    // O notebook dormiu nove minutos. O relógio anda, o batimento não.
    vi.setSystemTime(Date.now() + 9 * 60_000);
    h.socket().drop();
    await vi.advanceTimersByTimeAsync(300);
    await h.becomeReady();

    expect(h.tokenRequests).toEqual([false, true]);
    expect(h.socket().sent[0]?.d.token).toBe('token-novo-da-api');
  });

  it('pedido feito no meio da queda espera o canal voltar', async () => {
    const h = harness();
    void h.stream.start();
    await h.becomeReady();
    h.socket().drop();

    const pedido = h.stream.request('closeProducer', { producerId: 'p1' });
    await vi.advanceTimersByTimeAsync(300);
    await h.becomeReady();
    await vi.advanceTimersByTimeAsync(0);

    const enviado = h.socket().lastRequest;
    expect(enviado).toMatchObject({ m: 'closeProducer', d: { producerId: 'p1' } });
    h.socket().receive({ t: 'res', id: enviado.id, ok: true, d: {} });
    await expect(pedido).resolves.toEqual({});
  });

  it('pedido em andamento na hora da queda falha — não fica esperando uma resposta que não vem', async () => {
    const h = harness();
    void h.stream.start();
    await h.becomeReady();
    const pedido = h.stream.request('produce', {
      transportId: 't',
      kind: 'audio',
      rtpParameters: {},
      trackKind: 'mic',
    });
    const falhou = expect(pedido).rejects.toMatchObject({ code: 'closed' });
    await vi.advanceTimersByTimeAsync(0);
    h.socket().drop();
    await falhou;
  });

  it('batimento: renova o token a cada resposta, e o silêncio derruba a conexão', async () => {
    const h = harness();
    void h.stream.start();
    await h.becomeReady({ heartbeatIntervalMs: 1_000 });

    await vi.advanceTimersByTimeAsync(1_000);
    const ping = h.socket().lastRequest;
    expect(ping.m).toBe('ping');
    h.socket().receive({ t: 'res', id: ping.id, ok: true, d: { now: 1, resumeToken: 'token-do-ping' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.stream.freshToken()).toBe('token-do-ping');

    // Daqui em diante o servidor não responde mais nada.
    const mudo = h.socket();
    await vi.advanceTimersByTimeAsync(1_000 + 10_000);
    expect(mudo.closedWith?.code).toBe(SIGNAL_CLOSE.clientRetry);
    expect(h.states.at(-1)).toBe('reconnecting');
  });
});

describe('fechamentos de que não se volta', () => {
  for (const [nome, code] of [
    ['outra aba assumiu', SIGNAL_CLOSE.replaced],
    ['a moderação removeu', SIGNAL_CLOSE.removed],
  ] as const) {
    it(`${nome}: não reconecta, e avisa com o código`, async () => {
      const h = harness();
      void h.stream.start();
      await h.becomeReady();

      const pedido = h.stream.request('ping', {});
      const falhou = expect(pedido).rejects.toBeInstanceOf(SignalRequestFailed);
      await vi.advanceTimersByTimeAsync(0);
      h.socket().drop(code);
      await falhou;

      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeSocket.instances).toHaveLength(1);
      expect(h.finalCloses).toEqual([code]);
      expect(h.states.at(-1)).toBe('closed');
    });
  }

  it('sair de propósito fecha com 1000 — o código que o servidor lê como despedida', async () => {
    const h = harness();
    void h.stream.start();
    await h.becomeReady();

    h.stream.close();
    expect(h.socket().closedWith).toEqual({ code: 1000, reason: 'leave' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    await expect(h.stream.request('ping', {})).rejects.toMatchObject({ code: 'closed' });
  });

  it('sair antes de o canal abrir não deixa quem chamou esperando', async () => {
    const h = harness();
    const started = h.stream.start();
    const falhou = expect(started).rejects.toBeInstanceOf(SignalUnavailable);
    h.stream.close();
    await falhou;
  });
});
