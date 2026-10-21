import { readVoiceE2eeHook } from '../storage';

/**
 * Gancho de E2EE por quadro — o lugar onde o DAVE do Discord entraria.
 *
 * Hoje NÃO criptografa nada: liga um `RTCRtpScriptTransform` que passa cada
 * quadro codificado por `voiceFrameWorker.ts` e devolve o quadro intacto. É o
 * encanamento pronto (worker, contexto de quem manda e quem recebe, sender e
 * receiver de cada transporte), para a criptografia ser só o corpo de
 * `transformFrame` lá no worker.
 *
 * Desligado por padrão (`readVoiceE2eeHook`). Só usa `RTCRtpScriptTransform`:
 * o caminho antigo do Chrome (`createEncodedStreams`) exige
 * `encodedInsertableStreams: true` na PeerConnection inteira, e aí TODA track
 * — vídeo incluído — precisaria do mesmo tratamento, senão para de sair.
 */

export interface VoiceFrameContext {
  direction: 'send' | 'recv';
  /** `mic`, `screen-audio`… */
  trackKind: string;
  /** De quem é a mídia: o próprio participante no envio, o remoto na recepção. */
  peerId: string;
}

type TransformTarget = RTCRtpSender | RTCRtpReceiver;

interface ScriptTransformCtor {
  new (worker: Worker, options?: unknown, transfer?: Transferable[]): unknown;
}

let worker: Worker | null = null;

function scriptTransform(): ScriptTransformCtor | null {
  const ctor = (globalThis as { RTCRtpScriptTransform?: ScriptTransformCtor }).RTCRtpScriptTransform;
  return typeof ctor === 'function' ? ctor : null;
}

export function isVoiceFrameTransformEnabled(): boolean {
  return readVoiceE2eeHook() && scriptTransform() !== null;
}

/**
 * Pendura o transform no sender/receiver. `false` com o gancho desligado,
 * sem suporte no navegador, ou se o alvo já tem um transform (de outra
 * camada — o E2EE do próprio LiveKit, por exemplo).
 */
export function attachVoiceFrameTransform(target: TransformTarget, context: VoiceFrameContext): boolean {
  const Ctor = scriptTransform();
  if (!readVoiceE2eeHook() || Ctor === null) return false;
  const withTransform = target as unknown as { transform?: unknown };
  if (withTransform.transform != null) return false;
  try {
    worker ??= new Worker(new URL('./voiceFrameWorker.ts', import.meta.url), { type: 'module', name: 'voice-e2ee' });
    withTransform.transform = new Ctor(worker, context);
    return true;
  } catch {
    return false;
  }
}
