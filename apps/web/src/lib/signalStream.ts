/**
 * O canal de mídia do transporte mediasoup, visto do navegador: um WebSocket
 * aberto direto com o nó do SFU, por onde passa tudo o que faz a voz e a tela
 * funcionarem — ver `signalProtocol.ts` em `@telecord/shared` para o porquê.
 *
 * Esta classe cuida só do CANO: conectar, identificar, casar resposta com
 * pedido, perceber que caiu e voltar. O que fazer com a sessão de mídia depois
 * de voltar é de `MediasoupConnection`, que recebe o `ready` e decide.
 *
 * ## Voltar sozinho
 *
 * Uma vez que o canal ficou pronto, qualquer queda vira tentativa de volta —
 * rede que piscou, o SFU reiniciando num deploy, o notebook que dormiu. As
 * exceções são os dois fechamentos em que voltar seria errado
 * (`isSignalCloseFinal`): a mesma pessoa abriu a sala em outra aba, ou a
 * moderação a removeu.
 *
 * Antes de ficar pronto pela primeira vez a regra é outra: duas tentativas e
 * desiste, devolvendo o erro a quem chamou — que cai no caminho HTTP antigo.
 * É o que mantém a sala funcionando contra um SFU que ainda não tem este
 * canal (a janela entre o deploy do site e o do servidor).
 */
import {
  isSignalCloseFinal,
  parseSignalServerFrame,
  SIGNAL_CLOSE,
  SIGNAL_PATH,
  SIGNAL_PROTOCOL_VERSION,
  type SignalErrorCode,
  type SignalEventName,
  type SignalEvents,
  type SignalMethod,
  type SignalReady,
  type SignalRequests,
  type SignalResponses,
} from '@telecord/shared';

export type SignalStreamState = 'connecting' | 'ready' | 'reconnecting' | 'closed';

/** Um pedido que não deu certo — recusado pelo servidor, sem resposta a tempo, ou com o canal fechado. */
export class SignalRequestFailed extends Error {
  constructor(
    readonly code: SignalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SignalRequestFailed';
  }
}

/** O canal não abriu nas primeiras tentativas. Quem chama decide o que fazer no lugar. */
export class SignalUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalUnavailable';
  }
}

export interface SignalStreamOptions {
  /** Origem do nó do SFU, `http(s)://…` — a mesma do socket de presença. */
  nodeUrl: string;
  /**
   * Um token para se identificar. `fresh` pede um NOVO a `apps/api`: o que se
   * tinha venceu, ou o servidor recusou.
   */
  getToken: (fresh: boolean) => Promise<string>;
  /** A sessão de mídia que este cliente acha que ainda tem — é o que permite retomar. */
  getSessionId: () => string | null;
  /** Identifica esta página perante o SFU — o mesmo valor do socket de presença. */
  instanceId: string;
  /**
   * O canal ficou pronto. Chamado ANTES de qualquer evento que chegue depois
   * do `ready`, e de forma síncrona: é o que deixa o retrato da sala ser
   * aplicado sem um `track:announced` passar na frente dele.
   */
  onReady: (ready: SignalReady, reconnected: boolean) => void;
  onEvent: <E extends SignalEventName>(name: E, data: SignalEvents[E]) => void;
  onStateChange: (state: SignalStreamState) => void;
  /** Fechamento depois do qual não se volta — ver `isSignalCloseFinal`. */
  onFinalClose: (code: number) => void;
  /** Só para teste: o construtor de WebSocket a usar no lugar do global. */
  WebSocketCtor?: typeof WebSocket;
}

/** Quanto esperar a resposta de um pedido. Folgado: o SFU responde em milissegundos. */
const REQUEST_TIMEOUT_MS = 10_000;

/** Quanto esperar o WebSocket abrir e o `identify` responder. */
const CONNECT_TIMEOUT_MS = 6_000;

/** Tentativas antes de o canal ficar pronto pela PRIMEIRA vez. */
const INITIAL_ATTEMPTS = 2;

/**
 * O token devolvido pelo servidor vale 10 minutos (`RESUME_TOKEN_TTL_MS` no
 * SFU). Com mais de 8 de idade já se pede outro a `apps/api`, em vez de
 * apostar a reconexão nos últimos instantes de validade.
 */
const RESUME_TOKEN_MAX_AGE_MS = 8 * 60_000;

const BACKOFF_BASE_MS = 300;
const BACKOFF_MAX_MS = 8_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** `http(s)://nó` → `ws(s)://nó/signal`. */
export function signalUrl(nodeUrl: string): string {
  return `${nodeUrl.replace(/\/$/, '').replace(/^http/, 'ws')}${SIGNAL_PATH}`;
}

/**
 * Quanto esperar antes da tentativa `attempt` (a partir de 0). Dobra a cada
 * vez até o teto, com até 30% de sorteio para que uma sala inteira derrubada
 * pelo mesmo deploy não volte toda no mesmo milissegundo.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.round(base * (0.7 + random() * 0.3));
}

export class SignalStream {
  private ws: WebSocket | null = null;
  private state: SignalStreamState = 'connecting';
  private stopped = false;
  private everReady = false;
  private attempt = 0;
  private nextId = 1;
  private identifyId: number | null = null;
  private readonly pending = new Map<number, Pending>();
  /** Pedidos feitos com o canal fora do ar, esperando ele voltar. */
  private readonly waitingReady = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private resumeToken: { value: string; at: number } | null = null;
  private needFreshToken = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private startResolve: ((ready: SignalReady) => void) | null = null;
  private startReject: ((error: Error) => void) | null = null;

  constructor(private readonly options: SignalStreamOptions) {}

  /** Abre o canal. Resolve no primeiro `ready`; rejeita com `SignalUnavailable` se ele não vier. */
  start(): Promise<SignalReady> {
    return new Promise<SignalReady>((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
      this.open();
    });
  }

  get currentState(): SignalStreamState {
    return this.state;
  }

  /** O token mais novo que o servidor devolveu, se ainda estiver longe de vencer. */
  freshToken(): string | null {
    if (this.resumeToken === null) return null;
    return Date.now() - this.resumeToken.at < RESUME_TOKEN_MAX_AGE_MS ? this.resumeToken.value : null;
  }

  /**
   * Manda um pedido e espera a resposta.
   *
   * Com o canal fora do ar por um instante, o pedido ESPERA ele voltar em vez
   * de falhar na hora: quem clicou em ligar o microfone no meio de uma queda
   * de dois segundos não precisa saber que ela aconteceu.
   */
  async request<M extends Exclude<SignalMethod, 'identify'>>(
    method: M,
    data: SignalRequests[M],
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<SignalResponses[M]> {
    if (this.state !== 'ready') await this.untilReady(timeoutMs);
    return this.send(method, data, timeoutMs) as Promise<SignalResponses[M]>;
  }

  /**
   * Derruba a conexão atual e conecta de novo. Usado quando o que o cliente
   * acha que tem deixou de bater com o servidor — o `ready` da volta é que
   * diz o que ainda existe.
   */
  restart(): void {
    if (this.stopped) return;
    if (this.ws !== null && this.ws.readyState <= 1) {
      this.ws.close(SIGNAL_CLOSE.clientRetry, 'restart');
      return;
    }
    this.scheduleRetry(0);
  }

  /** Sai de propósito. O código 1000 é o que o servidor lê como despedida. */
  close(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.failAll(new SignalRequestFailed('closed', 'O canal de mídia foi encerrado.'));
    const ws = this.ws;
    this.ws = null;
    if (ws !== null && ws.readyState <= 1) ws.close(1000, 'leave');
    this.setState('closed');
    // Quem ainda esperava o primeiro `ready` não fica esperando para sempre.
    const reject = this.startReject;
    this.startResolve = null;
    this.startReject = null;
    reject?.(new SignalUnavailable('O canal de mídia foi encerrado antes de abrir.'));
  }

  private open(): void {
    if (this.stopped) return;
    const Ctor = this.options.WebSocketCtor ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Ctor(signalUrl(this.options.nodeUrl));
    } catch (error) {
      this.handleDown(null, error instanceof Error ? error.message : 'URL inválida');
      return;
    }
    this.ws = ws;

    // Um servidor que aceita o TCP e nunca responde não dispara `onerror`:
    // sem este teto a conexão ficaria "abrindo" para sempre.
    this.connectTimer = setTimeout(() => {
      if (this.ws === ws && this.state !== 'ready') ws.close(SIGNAL_CLOSE.clientRetry, 'connect_timeout');
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      void this.identify(ws);
    };
    ws.onmessage = (event: MessageEvent) => {
      if (this.ws !== ws) return;
      this.handleMessage(event.data);
    };
    ws.onclose = (event: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.handleDown(event.code, event.reason);
    };
    // O `onclose` vem logo em seguida e é ele quem decide; aqui só não pode
    // faltar ouvinte, para o erro não aparecer como exceção solta no console.
    ws.onerror = () => undefined;
  }

  private async identify(ws: WebSocket): Promise<void> {
    let token: string;
    try {
      const fresh = this.needFreshToken;
      this.needFreshToken = false;
      token = (fresh ? null : this.freshToken()) ?? (await this.options.getToken(fresh || this.everReady));
    } catch {
      // Sem token não há o que mandar: fecha e deixa a volta tentar de novo.
      if (this.ws === ws) ws.close(SIGNAL_CLOSE.clientRetry, 'token_unavailable');
      return;
    }
    if (this.ws !== ws || ws.readyState !== 1) return;

    const id = this.nextId;
    this.nextId += 1;
    this.identifyId = id;
    ws.send(
      JSON.stringify({
        t: 'req',
        id,
        m: 'identify',
        d: {
          token,
          protocol: SIGNAL_PROTOCOL_VERSION,
          sessionId: this.options.getSessionId(),
          instance: this.options.instanceId,
        },
      }),
    );
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    const frame = parseSignalServerFrame(parsed);
    if (frame === null) return;

    if (frame.t === 'evt') {
      // Evento antes do `ready` não tem retrato com que ser conferido.
      if (this.state === 'ready') this.options.onEvent(frame.e, frame.d);
      return;
    }

    if (frame.id === this.identifyId) {
      this.identifyId = null;
      if (frame.ok) {
        this.handleReady(frame.d as SignalReady);
      } else if (frame.code === 'unsupported') {
        // O nó fala outra versão: insistir não muda a resposta.
        this.giveUp(`O nó não atende o protocolo ${SIGNAL_PROTOCOL_VERSION}.`);
      } else if (frame.code === 'unauthenticated') {
        this.needFreshToken = true;
      }
      // Nos demais casos o servidor fecha a conexão logo em seguida, e é o
      // `onclose` que agenda a próxima tentativa.
      return;
    }

    const entry = this.pending.get(frame.id);
    if (entry === undefined) return;
    this.pending.delete(frame.id);
    clearTimeout(entry.timer);
    if (frame.ok) entry.resolve(frame.d);
    else entry.reject(new SignalRequestFailed(frame.code, frame.message));
  }

  private handleReady(ready: SignalReady): void {
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    const reconnected = this.everReady;
    this.everReady = true;
    this.attempt = 0;
    this.resumeToken = { value: ready.resumeToken, at: Date.now() };
    this.setState('ready');

    // Síncrono, antes de liberar quem esperava: quem recebe aplica o retrato
    // da sala aqui, e só depois os pedidos represados e os eventos seguintes
    // encontram o estado já conferido.
    this.options.onReady(ready, reconnected);

    for (const waiter of this.waitingReady) waiter.resolve();
    this.waitingReady.clear();

    this.heartbeatTimer = setInterval(() => void this.heartbeat(), ready.heartbeatIntervalMs);

    const resolve = this.startResolve;
    this.startResolve = null;
    this.startReject = null;
    resolve?.(ready);
  }

  /**
   * O `ping` de aplicação existe para o CLIENTE perceber uma conexão morta:
   * o navegador não mostra à página os pings do protocolo que o servidor
   * manda. De quebra, cada resposta traz um token renovado.
   */
  private async heartbeat(): Promise<void> {
    if (this.state !== 'ready') return;
    const ws = this.ws;
    try {
      const pong = await this.send('ping', {}, REQUEST_TIMEOUT_MS);
      this.resumeToken = { value: pong.resumeToken, at: Date.now() };
    } catch (error) {
      // Só o silêncio derruba: resposta de erro é sinal de que há alguém lá.
      const silent = error instanceof SignalRequestFailed && error.code === 'timeout';
      if (silent && this.ws === ws && ws !== null) ws.close(SIGNAL_CLOSE.clientRetry, 'heartbeat_timeout');
    }
  }

  private send<M extends SignalMethod>(
    method: M,
    data: SignalRequests[M],
    timeoutMs: number,
  ): Promise<SignalResponses[M]> {
    const ws = this.ws;
    if (ws === null || ws.readyState !== 1 || this.state !== 'ready') {
      return Promise.reject(new SignalRequestFailed('closed', 'O canal de mídia não está aberto.'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<SignalResponses[M]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SignalRequestFailed('timeout', `O servidor não respondeu a '${method}' a tempo.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ t: 'req', id, m: method, d: data }));
    });
  }

  private untilReady(timeoutMs: number): Promise<void> {
    if (this.state === 'closed') {
      return Promise.reject(new SignalRequestFailed('closed', 'O canal de mídia foi encerrado.'));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.waitingReady.delete(waiter);
        reject(new SignalRequestFailed('timeout', 'O canal de mídia não voltou a tempo.'));
      }, timeoutMs);
      this.waitingReady.add(waiter);
    });
  }

  /** A conexão caiu, ou nem chegou a abrir. `code` é `null` quando o WebSocket não pôde ser criado. */
  private handleDown(code: number | null, reason: string): void {
    this.clearTimers();
    this.identifyId = null;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new SignalRequestFailed('closed', 'O canal de mídia caiu antes da resposta.'));
      this.pending.delete(id);
    }
    if (this.stopped) return;

    if (code !== null && isSignalCloseFinal(code)) {
      this.stopped = true;
      this.failAll(new SignalRequestFailed('closed', 'O canal de mídia foi encerrado pelo servidor.'));
      this.setState('closed');
      this.options.onFinalClose(code);
      return;
    }
    if (code === SIGNAL_CLOSE.unauthenticated) this.needFreshToken = true;

    if (!this.everReady) {
      this.attempt += 1;
      if (this.attempt >= INITIAL_ATTEMPTS) {
        this.giveUp(`O canal de mídia não abriu (${code ?? 'sem conexão'}${reason === '' ? '' : `: ${reason}`}).`);
        return;
      }
      this.scheduleRetry(BACKOFF_BASE_MS);
      return;
    }

    this.setState('reconnecting');
    const delay = backoffDelay(this.attempt);
    this.attempt += 1;
    this.scheduleRetry(delay);
  }

  private scheduleRetry(delayMs: number): void {
    if (this.stopped || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delayMs);
  }

  /** Desiste ANTES de ter ficado pronto: é o sinal para quem chamou usar o caminho HTTP. */
  private giveUp(message: string): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws !== null && ws.readyState <= 1) ws.close(SIGNAL_CLOSE.clientRetry, 'give_up');
    const error = new SignalUnavailable(message);
    this.failAll(error);
    this.setState('closed');
    const reject = this.startReject;
    this.startResolve = null;
    this.startReject = null;
    reject?.(error);
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waitingReady) waiter.reject(error);
    this.waitingReady.clear();
  }

  private clearTimers(): void {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.connectTimer !== null) clearTimeout(this.connectTimer);
    this.heartbeatTimer = null;
    this.retryTimer = null;
    this.connectTimer = null;
  }

  private setState(state: SignalStreamState): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onStateChange(state);
  }
}
