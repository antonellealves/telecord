import { useEffect, useRef, useState } from 'react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { LocalAudioTrack, type Room } from 'livekit-client';
import { NOISE_SUPPRESSION_EVENT, readNoiseSuppression } from '../lib/storage';

/**
 * - `krisp`: filtro de IA da Krisp ativo no microfone.
 * - `browser`: supressão nativa do navegador (Krisp indisponível).
 * - `idle`: ligado, esperando o microfone ser publicado para escolher.
 * - `off`: desligado pela pessoa.
 */
export type NoiseFilterStatus = 'krisp' | 'browser' | 'idle' | 'off';

/** `name` fixo do processador em `@livekit/krisp-noise-filter`. */
const KRISP_PROCESSOR_NAME = 'livekit-noise-filter';

async function setBrowserNoiseSuppression(
  room: Room,
  track: LocalAudioTrack | null,
  enabled: boolean,
): Promise<void> {
  room.options.audioCaptureDefaults = { ...room.options.audioCaptureDefaults, noiseSuppression: enabled };
  if (track === null) return;
  const media = track.mediaStreamTrack;
  // `applyConstraints` troca o conjunto inteiro — mescla para não perder
  // dispositivo, taxa de amostragem e o resto do que já foi pedido.
  await media.applyConstraints({ ...media.getConstraints(), noiseSuppression: enabled }).catch(() => undefined);
}

async function reconcile(
  room: Room,
  track: LocalAudioTrack | null,
  wanted: boolean,
  krispRejected: { current: boolean },
): Promise<NoiseFilterStatus> {
  const hasKrisp = track?.getProcessor()?.name === KRISP_PROCESSOR_NAME;

  if (!wanted) {
    if (track !== null && hasKrisp) await track.stopProcessor();
    await setBrowserNoiseSuppression(room, track, false);
    return 'off';
  }

  // Sem microfone no ar, a próxima captura nasce com o filtro do navegador;
  // o Krisp entra por cima quando a track aparecer.
  if (track === null) {
    await setBrowserNoiseSuppression(room, null, true);
    return krispRejected.current ? 'browser' : 'idle';
  }
  if (hasKrisp) return 'krisp';

  if (!krispRejected.current) {
    // Import dinâmico: o pacote carrega um modelo de IA pesado, que só deve
    // baixar para quem de fato liga o microfone numa sala LiveKit.
    const { KrispNoiseFilter, isKrispNoiseFilterSupported } = await import('@livekit/krisp-noise-filter');
    if (isKrispNoiseFilterSupported()) {
      const processor = KrispNoiseFilter({ quality: 'high' });
      try {
        await track.setProcessor(processor);
        await processor.setEnabled(true);
        if (processor.isEnabled()) return 'krisp';
      } catch {
        // Cai no filtro do navegador logo abaixo.
      }
      /*
       * O Krisp é recurso do LiveKit Cloud: ele confere a licença no servidor
       * com o token da sala, e um LiveKit self-hosted recusa. Recusado, o
       * processador fica no caminho SEM filtrar — e ele já desligou a
       * supressão do navegador ao iniciar. Tirá-lo é o que evita o microfone
       * ficar sem supressão nenhuma.
       */
      await track.stopProcessor().catch(() => undefined);
    }
    krispRejected.current = true;
  }

  await setBrowserNoiseSuppression(room, track, true);
  return 'browser';
}

/**
 * Supressão de ruído do microfone na sala LiveKit: Krisp quando o servidor
 * autoriza, a do navegador quando não.
 *
 * É o ÚNICO dono da constraint `noiseSuppression` nesta sala — o painel de
 * configurações só grava a preferência (`NOISE_SUPPRESSION_EVENT`). Com dois
 * donos, o filtro do navegador voltava a ligar por baixo do Krisp a cada
 * troca, e a voz passava por dois filtros em série.
 */
export function useNoiseFilter(): NoiseFilterStatus {
  const room = useRoomContext();
  const { microphoneTrack } = useLocalParticipant();
  const track = microphoneTrack?.track instanceof LocalAudioTrack ? microphoneTrack.track : null;

  const [wanted, setWanted] = useState(readNoiseSuppression);
  const [status, setStatus] = useState<NoiseFilterStatus>(() => (readNoiseSuppression() ? 'idle' : 'off'));
  const krispRejected = useRef(false);
  // Uma troca por vez: ligar e desligar rápido não pode intercalar
  // `setProcessor` com `stopProcessor` na mesma track.
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const handle = (event: Event): void => {
      setWanted((event as CustomEvent<boolean>).detail);
    };
    window.addEventListener(NOISE_SUPPRESSION_EVENT, handle);
    return () => window.removeEventListener(NOISE_SUPPRESSION_EVENT, handle);
  }, []);

  useEffect(() => {
    let current = true;
    queue.current = queue.current
      .then(() => reconcile(room, track, wanted, krispRejected))
      .then((next) => {
        if (current) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [room, track, wanted]);

  return status;
}
