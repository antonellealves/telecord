import { Duplex } from 'node:stream';
import type { RawData, WebSocket } from 'ws';

/**
 * Um WebSocket visto como stream do Node: ler é receber quadro, escrever é
 * mandar quadro.
 *
 * ## O que isto compra
 *
 * Contrapressão de ponta a ponta, sem uma linha de controle escrita à mão.
 * Quando quem atende os pedidos não dá conta, o `push` devolve `false`, o
 * socket é pausado e o TCP segura o cliente — a memória deste processo não
 * cresce com a pressa de ninguém. No sentido contrário, o `callback` de cada
 * escrita só volta quando o quadro saiu para o kernel: um cliente que parou
 * de ler faz a fila de saída encher DEVAGAR e na camada certa, onde
 * `OutboundQueue` decide o que pode esperar e o que pode ser substituído.
 *
 * ## Por que não o `createWebSocketStream` do próprio `ws`
 *
 * Ele serve, com duas diferenças que aqui importam: fecha sempre sem código
 * (e o cliente decide se reconecta pelo código — ver `SIGNAL_CLOSE`), e o lado
 * de escrita é de bytes — por padrão a string vira Buffer e sai como quadro
 * binário. Aqui o modo é de objeto nos dois sentidos: um pedaço do stream é
 * exatamente um quadro de texto.
 */
export class WebSocketDuplex extends Duplex {
  private closeCode = 1000;
  private closeReason = '';

  constructor(private readonly ws: WebSocket) {
    super({
      readableObjectMode: true,
      writableObjectMode: true,
      // Poucos quadros de folga em cada sentido: o bastante para não parar o
      // socket a cada mensagem, pouco o bastante para a contrapressão chegar
      // cedo a quem precisa saber dela.
      readableHighWaterMark: 8,
      writableHighWaterMark: 8,
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      // Texto vira string. Binário segue como Buffer e o decodificador
      // recusa — o protocolo não tem quadro binário.
      const chunk: string | Buffer = isBinary ? toBuffer(data) : toBuffer(data).toString('utf8');
      if (!this.push(chunk)) ws.pause();
    });
    ws.once('close', () => {
      if (!this.destroyed) this.push(null);
    });
    ws.once('error', (error: Error) => {
      this.destroy(error);
    });
  }

  /** Com que código o WebSocket fecha quando o lado de escrita terminar. */
  setClose(code: number, reason: string): void {
    this.closeCode = code;
    this.closeReason = reason;
  }

  override _read(): void {
    if (this.ws.isPaused) this.ws.resume();
  }

  override _write(chunk: string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.ws.readyState !== this.ws.OPEN) {
      callback(new Error('o WebSocket já não está aberto'));
      return;
    }
    this.ws.send(chunk, (error) => callback(error ?? null));
  }

  /**
   * Chamado quando não há mais nada a escrever. O quadro de fechamento entra
   * na fila do socket DEPOIS de tudo o que já foi escrito, então a última
   * resposta chega antes do código que explica por que a conexão acabou.
   */
  override _final(callback: (error?: Error | null) => void): void {
    if (this.ws.readyState === this.ws.CLOSED) {
      callback();
      return;
    }
    this.ws.once('close', () => callback());
    if (this.ws.readyState === this.ws.OPEN) this.ws.close(this.closeCode, this.closeReason);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.ws.readyState !== this.ws.CLOSED) this.ws.terminate();
    callback(error);
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}
