import { Writable } from 'node:stream';
import {
  SIGNAL_CLOSE,
  type SignalErrorCode,
  type SignalErrorFrame,
  type SignalMethod,
  type SignalRequests,
  type SignalResponseFrame,
  type SignalResponses,
} from '@telecord/shared';
import type { LogFields } from '../log';
import { BadRequestError, NotFoundError } from '../rooms';
import type { DecodedFrame } from './frames';
import type { SignalSession } from './session';

/** Erro que o atendimento levanta de propósito, já com o código que o cliente recebe. */
export class SignalRequestError extends Error {
  constructor(
    readonly code: SignalErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type SignalHandlers = {
  [M in SignalMethod]: (
    session: SignalSession,
    data: SignalRequests[M],
  ) => Promise<SignalResponses[M]> | SignalResponses[M];
};

/**
 * O fim da linha de entrada: recebe pedidos já conferidos e os atende.
 *
 * ## Um de cada vez, por conexão
 *
 * `Writable` só entrega o próximo pedaço depois do `callback` do anterior.
 * É a garantia de ordem de que a sinalização precisa — `connectTransport`
 * termina antes de `produce` começar, `produce` antes de `closeProducer` —
 * sem trava nem fila escrita à mão. Conexões diferentes continuam
 * independentes: cada uma tem o seu.
 *
 * ## E é aqui que a contrapressão começa
 *
 * Enquanto um pedido espera o Worker, os seguintes ficam no buffer deste
 * stream. Passou de `highWaterMark`, o decodificador para, o socket é
 * pausado e o TCP segura o cliente. Quem dispara mil pedidos não ocupa mil
 * pedidos de memória.
 */
export class RequestDispatcher extends Writable {
  constructor(
    private readonly session: SignalSession,
    private readonly handlers: SignalHandlers,
    private readonly log: (fields: LogFields) => void,
  ) {
    super({ objectMode: true, highWaterMark: 32 });
  }

  override _write(
    decoded: DecodedFrame,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.handle(decoded).then(
      () => callback(),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
    );
  }

  private async handle(decoded: DecodedFrame): Promise<void> {
    const session = this.session;
    // Conexão a caminho de fechar não atende mais nada — nem responde.
    if (session.closing) return;

    if (!decoded.ok) {
      session.close(SIGNAL_CLOSE.protocolError, decoded.reason);
      return;
    }
    const { frame } = decoded;

    if (session.identity === null && frame.m !== 'identify') {
      session.respond(errorFrame(frame.id, 'unauthenticated', 'Mande `identify` antes de qualquer pedido.'));
      session.close(SIGNAL_CLOSE.unauthenticated, 'identify_required');
      return;
    }

    session.holdEvents();
    let response: SignalResponseFrame;
    try {
      const handler = this.handlers[frame.m] as (
        session: SignalSession,
        data: unknown,
      ) => Promise<unknown> | unknown;
      response = { t: 'res', id: frame.id, ok: true, d: await handler(session, frame.d) };
    } catch (error) {
      response = this.toErrorFrame(frame.id, frame.m, error);
    }
    session.respond(response);

    // O token não serviu: a resposta acima explica, o código diz o que fazer.
    if (frame.m === 'identify' && !response.ok) {
      session.close(
        response.code === 'unauthenticated' ? SIGNAL_CLOSE.unauthenticated : SIGNAL_CLOSE.protocolError,
        response.code,
      );
    }
  }

  private toErrorFrame(id: number, method: SignalMethod, error: unknown): SignalErrorFrame {
    if (error instanceof SignalRequestError) return errorFrame(id, error.code, error.message);
    if (error instanceof NotFoundError) return errorFrame(id, 'not_found', error.message);
    if (error instanceof BadRequestError) return errorFrame(id, 'bad_request', error.message);

    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : 'Error';
    this.log({
      event: 'signal_request_failed',
      method,
      error: name,
      message,
      roomSlug: this.session.identity?.roomSlug,
      peerId: this.session.identity?.peerId,
    });
    // O mediasoup recusa parâmetro de mídia malformado com TypeError ou
    // UnsupportedError: é culpa de quem mandou, e a mensagem dele diz o quê.
    if (error instanceof TypeError || name === 'UnsupportedError') {
      return errorFrame(id, 'bad_request', message);
    }
    return errorFrame(id, 'internal', 'erro interno');
  }
}

function errorFrame(id: number, code: SignalErrorCode, message: string): SignalErrorFrame {
  return { t: 'res', id, ok: false, code, message };
}
