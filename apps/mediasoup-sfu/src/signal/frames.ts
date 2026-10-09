import { Transform, type TransformCallback } from 'node:stream';
import {
  parseSignalRequestFrame,
  SIGNAL_MAX_FRAME_BYTES,
  type SignalRequestFrame,
  type SignalServerFrame,
} from '@telecord/shared';

/**
 * O que saiu de um quadro: um pedido válido, ou o motivo de não ser.
 *
 * Quadro inválido NÃO vira erro de stream. Erro de stream derruba a conexão
 * sem dizer por quê, e aqui quem recebe o problema precisa fechar com um
 * código (`SIGNAL_CLOSE.protocolError`) que o cliente saiba ler.
 */
export type DecodedFrame =
  | { ok: true; frame: SignalRequestFrame }
  | { ok: false; reason: string };

export function decodeFrame(chunk: unknown): DecodedFrame {
  if (typeof chunk !== 'string') return { ok: false, reason: 'quadro binário' };
  // `maxPayload` do servidor já barra isto antes; a conferência fica para o
  // decodificador não depender de quem o instanciou.
  if (chunk.length > SIGNAL_MAX_FRAME_BYTES) return { ok: false, reason: 'quadro grande demais' };
  let raw: unknown;
  try {
    raw = JSON.parse(chunk) as unknown;
  } catch {
    return { ok: false, reason: 'JSON inválido' };
  }
  const frame = parseSignalRequestFrame(raw);
  return frame === null ? { ok: false, reason: 'envelope inválido' } : { ok: true, frame };
}

/** Quadro de texto → pedido conferido. Um por vez: quem dita o ritmo é o atendimento. */
export class FrameDecoder extends Transform {
  constructor() {
    super({ objectMode: true, highWaterMark: 1 });
  }

  override _transform(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback): void {
    callback(null, decodeFrame(chunk));
  }
}

/** Resposta ou evento → quadro de texto. */
export class FrameEncoder extends Transform {
  constructor() {
    super({ objectMode: true, highWaterMark: 1 });
  }

  override _transform(
    frame: SignalServerFrame,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    callback(null, JSON.stringify(frame));
  }
}
