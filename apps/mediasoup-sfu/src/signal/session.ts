import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { SignalEventName, SignalEvents, SignalResponseFrame } from '@telecord/shared';
import { OutboundQueue } from './outbound';
import type { WebSocketDuplex } from './socketStream';

export interface SignalIdentity {
  peerId: string;
  roomSlug: string;
  displayName: string;
}

/**
 * Depois de pedir um fechamento educado, quanto esperar a fila esvaziar antes
 * de cortar. Cliente que não lê nunca esvazia a fila, e sem este teto a
 * conexão dele ficaria aberta até o sistema operacional desistir.
 */
const CLOSE_FLUSH_MS = 5_000;

/**
 * Uma conexão do canal de mídia, do `upgrade` ao `close`.
 *
 * Guarda quem é o par (depois do `identify`), a fila de saída dele e o motivo
 * de a conexão estar fechando — que é o que distingue "a pessoa saiu" de "o
 * servidor mandou embora" na hora de decidir o que fazer com a sessão de
 * mídia.
 */
export class SignalSession {
  readonly id = randomUUID();
  readonly outbound: OutboundQueue;
  identity: SignalIdentity | null = null;
  /** Código com que o SERVIDOR decidiu fechar; `null` se foi o cliente ou a rede. */
  serverCloseCode: number | null = null;
  closed = false;
  /** Um `ping` saiu e o `pong` ainda não voltou — ver o batimento em `server.ts`. */
  awaitingPong = false;

  private held: (() => void)[] | null = null;
  private killTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly duplex: WebSocketDuplex,
    queueLimit: number,
  ) {
    this.outbound = new OutboundQueue(queueLimit, () => this.terminate());
  }

  get closing(): boolean {
    return this.closed || this.serverCloseCode !== null;
  }

  /** Evento que não pode se perder nem sair de ordem. */
  sendEvent<E extends SignalEventName>(name: E, data: SignalEvents[E]): void {
    this.deliver(() => this.outbound.enqueue({ t: 'evt', e: name, d: data }));
  }

  /** Evento em que só o mais recente interessa — ver a faixa volátil de `OutboundQueue`. */
  sendLatest<E extends SignalEventName>(name: E, data: SignalEvents[E]): void {
    this.deliver(() => this.outbound.enqueueLatest(name, { t: 'evt', e: name, d: data }));
  }

  /**
   * Do começo de um pedido até a resposta dele entrar na fila, os eventos
   * esperam.
   *
   * Sem isto a ordem dependia de corrida entre promessas: o aviso de que um
   * consumer fechou podia sair ANTES da resposta que o criou, e o cliente
   * montava uma track para algo que já não existia. É também o que deixa o
   * `identify` devolver um retrato da sala sem buraco entre o retrato e o
   * primeiro evento.
   */
  holdEvents(): void {
    this.held ??= [];
  }

  respond(frame: SignalResponseFrame): void {
    this.outbound.enqueue(frame);
    const held = this.held;
    this.held = null;
    if (held !== null) for (const send of held) send();
  }

  /**
   * Fecha com um código que o cliente sabe ler, DEPOIS de entregar o que já
   * estava na fila. O fechamento em si é feito pelo stream, quando a fila
   * termina — ver `WebSocketDuplex._final`.
   */
  close(code: number, reason: string): void {
    if (this.closing) return;
    this.serverCloseCode = code;
    this.duplex.setClose(code, reason);
    this.outbound.finish();
    this.killTimer = setTimeout(() => this.terminate(), CLOSE_FLUSH_MS);
    this.killTimer.unref();
  }

  /** Corta sem cerimônia. Para quem não responde, não há código que chegue. */
  terminate(): void {
    this.ws.terminate();
  }

  ping(): void {
    this.awaitingPong = true;
    this.ws.ping();
  }

  /** O WebSocket fechou de vez. Chamado uma única vez, por `server.ts`. */
  markClosed(): void {
    this.closed = true;
    this.held = null;
    if (this.killTimer !== null) clearTimeout(this.killTimer);
    this.killTimer = null;
    this.outbound.destroy();
  }

  private deliver(send: () => void): void {
    if (this.closing) return;
    if (this.held !== null) this.held.push(send);
    else send();
  }
}
