import { Readable } from 'node:stream';
import type { SignalEventFrame, SignalServerFrame } from '@telecord/shared';

/**
 * A fila de saída de UM cliente, como stream legível.
 *
 * ## Duas faixas
 *
 * Nem tudo o que sai tem a mesma urgência nem a mesma validade:
 *
 * - **crítica** — respostas e avisos de track. Sai em ordem, nunca é
 *   descartada: perder um `track:closed` deixaria uma tela congelada no palco
 *   de alguém para sempre.
 * - **volátil** — o que só vale enquanto é o mais recente. "Quem está falando"
 *   de meio segundo atrás não serve para nada; se o anterior ainda não saiu,
 *   o novo toma o lugar dele em vez de entrar atrás.
 *
 * A faixa crítica sempre sai primeiro. É o que garante que uma sala inteira
 * conversando ao mesmo tempo nunca atrase o `consume` de quem acabou de abrir
 * a tela.
 *
 * ## Por que stream, e não um `send` direto
 *
 * Porque o stream só PEDE o próximo quadro (`_read`) quando o anterior coube
 * no socket. Com o cliente em dia, cada evento sai na hora. Com o cliente
 * lento, ninguém pede — e é exatamente aí que a faixa volátil para de crescer
 * e passa a se sobrescrever. A fila se adapta à rede de cada um sem medir
 * nada.
 */
export class OutboundQueue extends Readable {
  private readonly critical: SignalServerFrame[] = [];
  private readonly latest = new Map<string, SignalEventFrame>();
  /** O stream pediu um quadro e ainda não recebeu. */
  private wanted = false;
  private finishing = false;

  constructor(
    /**
     * Quantos quadros críticos podem esperar. Passar disto quer dizer que o
     * cliente parou de ler: melhor derrubar e deixá-lo voltar com o estado
     * conferido do zero do que guardar memória por alguém que não escuta.
     */
    private readonly limit: number,
    private readonly onOverflow: () => void,
  ) {
    super({ objectMode: true, highWaterMark: 1 });
  }

  enqueue(frame: SignalServerFrame): void {
    if (this.finishing || this.destroyed) return;
    if (this.critical.length >= this.limit) {
      this.onOverflow();
      return;
    }
    this.critical.push(frame);
    this.pump();
  }

  /** `key` identifica o que é substituível pelo quê — na prática, o nome do evento. */
  enqueueLatest(key: string, frame: SignalEventFrame): void {
    if (this.finishing || this.destroyed) return;
    this.latest.set(key, frame);
    this.pump();
  }

  /** Entrega o que é crítico e encerra. O volátil não interessa a quem está saindo. */
  finish(): void {
    if (this.finishing) return;
    this.finishing = true;
    this.latest.clear();
    this.pump();
  }

  get pending(): number {
    return this.critical.length + this.latest.size;
  }

  override _read(): void {
    this.wanted = true;
    this.pump();
  }

  private pump(): void {
    while (this.wanted) {
      const next = this.nextFrame();
      if (next === undefined) {
        if (this.finishing) {
          this.wanted = false;
          this.push(null);
        }
        return;
      }
      // `push` devolve `false` quando o resto da cadeia está cheio: para
      // aqui e só volta no próximo `_read`.
      this.wanted = this.push(next);
    }
  }

  private nextFrame(): SignalServerFrame | undefined {
    const frame = this.critical.shift();
    if (frame !== undefined) return frame;
    for (const [key, value] of this.latest) {
      this.latest.delete(key);
      return value;
    }
    return undefined;
  }
}
