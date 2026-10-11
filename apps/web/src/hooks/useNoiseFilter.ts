import { useEffect, useRef, useState } from 'react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { LocalAudioTrack, type Room } from 'livekit-client';
import { applyBrowserNoiseSuppression } from '../lib/browserNoiseSuppression';
import { RNNOISE_PROCESSOR_NAME, RnnoiseProcessor, isRnnoiseSupported } from '../lib/rnnoiseProcessor';
import { NOISE_SUPPRESSION_EVENT, readNoiseSuppression } from '../lib/storage';

/**
 * - `krisp`: filtro de IA da Krisp ativo no microfone (só no LiveKit Cloud).
 * - `rnnoise`: filtro de IA RNNoise ativo no microfone.
 * - `browser`: supressão nativa do navegador (nenhum filtro de IA subiu).
 * - `idle`: ligado, esperando o microfone ser publicado para escolher.
 * - `off`: desligado pela pessoa.
 */
export type NoiseFilterStatus = 'krisp' | 'rnnoise' | 'browser' | 'idle' | 'off';

/** `name` fixo do processador em `@livekit/krisp-noise-filter`. */
const KRISP_PROCESSOR_NAME = 'livekit-noise-filter';

/** `ServerInfo_Edition.Cloud` em `@livekit/protocol`, que o SDK não reexporta. */
const LIVEKIT_CLOUD_EDITION = 1;

/** O que já deu errado nesta sala, para não tentar de novo a cada troca. */
interface FilterMemory {
  krispRejected: boolean;
  rnnoiseFailed: boolean;
}

/**
 * O Krisp só é licenciado no LiveKit Cloud, e o servidor diz qual é a edição
 * dele ao entrar na sala. Num self-hosted (o caso de `livekit/livekit.yaml`)
 * não adianta tentar: o processador entra, desliga a supressão do navegador,
 * passa a voz por um AudioWorklet — e a licença é recusada depois, sem filtrar
 * nada. Era um desvio que só custava qualidade e latência.
 */
function isLiveKitCloud(room: Room): boolean {
  return room.serverInfo?.edition === LIVEKIT_CLOUD_EDITION;
}

/**
 * A supressão do NAVEGADOR: nos defaults da sala, para a próxima captura já
 * nascer certa, e no microfone que estiver aberto. A track precisa estar sem
 * processador — com um, `mediaStreamTrack` é a saída do filtro, não a captura.
 */
async function setBrowserNoiseSuppression(
  room: Room,
  track: LocalAudioTrack | null,
  enabled: boolean,
): Promise<void> {
  room.options.audioCaptureDefaults = {
    ...room.options.audioCaptureDefaults,
    noiseSuppression: enabled,
    voiceIsolation: enabled,
  };
  if (track !== null) await applyBrowserNoiseSuppression(track, enabled);
}

async function reconcile(
  room: Room,
  track: LocalAudioTrack | null,
  wanted: boolean,
  memory: FilterMemory,
): Promise<NoiseFilterStatus> {
  const attached = track?.getProcessor()?.name;
  const hasKrisp = attached === KRISP_PROCESSOR_NAME;
  const hasRnnoise = attached === RNNOISE_PROCESSOR_NAME;

  if (!wanted) {
    if (track !== null && (hasKrisp || hasRnnoise)) await track.stopProcessor();
    await setBrowserNoiseSuppression(room, track, false);
    return 'off';
  }

  const rnnoiseUsable = !memory.rnnoiseFailed && isRnnoiseSupported();

  // Sem microfone no ar, só dá para preparar a PRÓXIMA captura: crua se o
  // RNNoise vai cuidar dela, já filtrada pelo navegador se não vai.
  if (track === null) {
    await setBrowserNoiseSuppression(room, null, !rnnoiseUsable);
    return rnnoiseUsable || !memory.krispRejected ? 'idle' : 'browser';
  }
  if (hasKrisp) return 'krisp';
  if (hasRnnoise) return 'rnnoise';

  if (!isLiveKitCloud(room)) memory.krispRejected = true;

  if (!memory.krispRejected) {
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
        // Cai no próximo filtro logo abaixo.
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
    memory.krispRejected = true;
  }

  if (rnnoiseUsable) {
    try {
      // O RNNoise recebe o microfone cru: por baixo dele, o filtro do
      // navegador só somaria os próprios cortes aos do RNNoise.
      await setBrowserNoiseSuppression(room, track, false);
      await track.setProcessor(new RnnoiseProcessor());
      return 'rnnoise';
    } catch {
      memory.rnnoiseFailed = true;
    }
  }

  await setBrowserNoiseSuppression(room, track, true);
  return 'browser';
}

/**
 * Supressão de ruído do microfone na sala LiveKit: Krisp quando o servidor
 * autoriza, RNNoise quando não, e a do navegador se nenhum dos dois subir.
 *
 * É o ÚNICO dono da constraint `noiseSuppression` nesta sala — o painel de
 * configurações só grava a preferência (`NOISE_SUPPRESSION_EVENT`). Com dois
 * donos, o filtro do navegador voltava a ligar por baixo do filtro de IA a
 * cada troca, e a voz passava por dois filtros em série.
 */
export function useNoiseFilter(): NoiseFilterStatus {
  const room = useRoomContext();
  const { microphoneTrack } = useLocalParticipant();
  const track = microphoneTrack?.track instanceof LocalAudioTrack ? microphoneTrack.track : null;

  const [wanted, setWanted] = useState(readNoiseSuppression);
  const [status, setStatus] = useState<NoiseFilterStatus>(() => (readNoiseSuppression() ? 'idle' : 'off'));
  const memory = useRef<FilterMemory>({ krispRejected: false, rnnoiseFailed: false });
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
      .then(() => reconcile(room, track, wanted, memory.current))
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
