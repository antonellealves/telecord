import { Device } from 'mediasoup-client';
import type { HandlerFactory, HandlerInterface } from 'mediasoup-client/types';
import { preferOpusOnly } from '../../lib/voice/codecPreferences';
import { mungeVoiceRecvSdp, mungeVoiceSendSdp } from '../../lib/voice/voiceSdp';

/**
 * `Device` do mediasoup-client com a política de SDP da voz.
 *
 * O mediasoup-client configura o Opus pelos `codecOptions` do `produce()`,
 * e isso cobre quase tudo — mas não tem ponto para `setCodecPreferences`,
 * para `createOffer({ voiceActivityDetection })` nem para garantir o `fmtp`
 * exato: a resposta que ele monta herda os parâmetros do Router do SFU, e um
 * SFU ainda não republicado manda `ptime=10`, `stereo=1`,
 * `maxaveragebitrate=510000`… direto para o encoder.
 *
 * Então o handler de cada transporte ganha, só NA INSTÂNCIA (nada global,
 * nada no protótipo):
 *
 * - **envio**: todo transceiver de áudio nasce só com Opus
 *   (`setCodecPreferences`); a oferta pede `voiceActivityDetection`; e a
 *   resposta do servidor, nas seções do MICROFONE, sai com o Opus igual ao
 *   do Discord — `minptime=10;useinbandfec=1;usedtx=1`, NACK e
 *   transport-cc. O áudio da tela não é tocado (ele é estéreo de propósito).
 * - **recepção**: a nossa resposta fica com o padrão do Chrome,
 *   `minptime=10;useinbandfec=1` (mais `stereo=1` onde houver), NACK e
 *   transport-cc.
 *
 * Depende do campo interno `_pc` do handler (o mesmo nome em todos os
 * handlers do mediasoup-client 3.x). Se uma versão futura mudar isso, a
 * política simplesmente não se aplica — a voz continua funcionando com os
 * `codecOptions`, e o painel de debug mostra a diferença.
 */

const voiceTracks = new WeakSet<MediaStreamTrack>();

/** Marca uma track como VOZ antes do `produce()`: é ela que recebe o fmtp do Discord. */
export function markVoiceTrack(track: MediaStreamTrack): void {
  voiceTracks.add(track);
}

type AddTransceiver = RTCPeerConnection['addTransceiver'];

function applyVoicePolicy(handler: HandlerInterface, direction: 'send' | 'recv'): void {
  const pc = (handler as unknown as { _pc?: unknown })._pc;
  if (typeof RTCPeerConnection === 'undefined' || !(pc instanceof RTCPeerConnection)) return;

  if (direction === 'send') {
    const voice = new Set<RTCRtpTransceiver>();
    const addTransceiver = pc.addTransceiver.bind(pc) as AddTransceiver;
    pc.addTransceiver = ((trackOrKind: MediaStreamTrack | string, init?: RTCRtpTransceiverInit) => {
      const transceiver = addTransceiver(trackOrKind, init);
      const kind = typeof trackOrKind === 'string' ? trackOrKind : trackOrKind.kind;
      if (kind === 'audio') {
        preferOpusOnly(transceiver);
        if (typeof trackOrKind !== 'string' && voiceTracks.has(trackOrKind)) voice.add(transceiver);
      }
      return transceiver;
    }) as AddTransceiver;

    const createOffer = pc.createOffer.bind(pc) as (options?: RTCOfferOptions) => Promise<RTCSessionDescriptionInit>;
    // Legado: o Chrome atual ignora — quem corta o silêncio é o DTX do Opus.
    // Fica para a oferta sair como a do Discord.
    pc.createOffer = ((options?: RTCOfferOptions) =>
      createOffer({ voiceActivityDetection: true, ...options } as RTCOfferOptions)) as typeof pc.createOffer;

    const setRemoteDescription = pc.setRemoteDescription.bind(pc);
    pc.setRemoteDescription = ((description: RTCSessionDescriptionInit) => {
      if (description?.type === 'answer' && typeof description.sdp === 'string') {
        const mids: string[] = [];
        for (const transceiver of voice) {
          if (transceiver.mid !== null && transceiver.direction !== 'stopped' && transceiver.sender.track !== null) {
            mids.push(transceiver.mid);
          }
        }
        if (mids.length > 0) return setRemoteDescription({ type: 'answer', sdp: mungeVoiceSendSdp(description.sdp, mids) });
      }
      return setRemoteDescription(description);
    }) as typeof pc.setRemoteDescription;
    return;
  }

  const setLocalDescription = pc.setLocalDescription.bind(pc);
  pc.setLocalDescription = ((description?: RTCSessionDescriptionInit) => {
    if (description?.type === 'answer' && typeof description.sdp === 'string') {
      return setLocalDescription({ type: 'answer', sdp: mungeVoiceRecvSdp(description.sdp) });
    }
    return setLocalDescription(description);
  }) as typeof pc.setLocalDescription;
}

/**
 * Cria o `Device` com o handler que o mediasoup-client escolheria sozinho
 * (Chrome111, Firefox120, Safari12…), embrulhado pela política acima.
 */
export function createVoiceDevice(): Device {
  const detected = new Device();
  const base = (detected as unknown as { _handlerFactory?: HandlerFactory })._handlerFactory;
  if (base === undefined) return detected;
  const handlerFactory: HandlerFactory = {
    name: base.name,
    factory: (options) => {
      const handler = base.factory(options);
      applyVoicePolicy(handler, options.direction);
      return handler;
    },
    getNativeRtpCapabilities: (options) => base.getNativeRtpCapabilities(options),
  };
  // Outros campos que versões futuras acrescentem à fábrica seguem junto.
  return new Device({ handlerFactory: { ...base, ...handlerFactory } });
}
