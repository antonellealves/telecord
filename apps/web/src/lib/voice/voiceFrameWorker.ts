/**
 * Worker do gancho de E2EE por quadro (ver `frameTransform.ts`).
 *
 * Cada `RTCRtpScriptTransform` criado com este worker dispara um
 * `rtctransform` aqui, com o par de streams (quadros codificados que chegam,
 * quadros que seguem) e o contexto passado em `options`.
 */

interface VoiceFrameContext {
  direction: 'send' | 'recv';
  trackKind: string;
  peerId: string;
}

interface EncodedFrame {
  data: ArrayBuffer;
}

interface RtcTransformer {
  readable: ReadableStream<EncodedFrame>;
  writable: WritableStream<EncodedFrame>;
  options: VoiceFrameContext;
}

/**
 * O ponto de extensão. Envio: cifrar `frame.data`. Recepção: decifrar.
 * Hoje devolve o quadro como veio.
 */
function transformFrame(frame: EncodedFrame, _context: VoiceFrameContext): EncodedFrame {
  return frame;
}

const scope = self as unknown as {
  onrtctransform: ((event: { transformer: RtcTransformer }) => void) | null;
};

scope.onrtctransform = (event) => {
  const { readable, writable, options } = event.transformer;
  void readable
    .pipeThrough(
      new TransformStream<EncodedFrame, EncodedFrame>({
        transform(frame, controller) {
          controller.enqueue(transformFrame(frame, options));
        },
      }),
    )
    .pipeTo(writable)
    .catch(() => undefined);
};
