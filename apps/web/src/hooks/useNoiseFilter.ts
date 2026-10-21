import { useEffect, useRef, useState } from 'react';
import { useLocalParticipant, useRoomContext } from '@livekit/components-react';
import { LocalAudioTrack, type Room } from 'livekit-client';
import {
  applyCaptureProcessing,
  captureOptionsFor,
  requestedProcessing,
  type CaptureProcessing,
} from '../lib/captureProcessing';
import { RNNOISE_PROCESSOR_NAME, RnnoiseProcessor, isRnnoiseSupported } from '../lib/rnnoiseProcessor';
import {
  ECHO_CANCELLATION_EVENT,
  NOISE_SUPPRESSION_EVENT,
  readEchoCancellation,
  readNoiseSuppression,
} from '../lib/storage';

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
 * O processamento de voz do NAVEGADOR: nos defaults da sala, para a próxima
 * captura já nascer certa, e no microfone que estiver aberto. A track precisa
 * estar sem processador — com um, `mediaStreamTrack` é a saída do filtro, não
 * a captura.
 */
async function setCapture(room: Room, track: LocalAudioTrack | null, processing: CaptureProcessing): Promise<void> {
  room.options.audioCaptureDefaults = { ...room.options.audioCaptureDefaults, ...captureOptionsFor(processing) };
  if (track !== null) await applyCaptureProcessing(track, processing);
}

/**
 * O mesmo, com um filtro de IA já na track. A captura crua fica escondida
 * atrás do processador, então o estado dela vem do que o LiveKit guardou em
 * `constraints` — que acompanha a realidade porque toda troca passa por
 * `setCapture` ou por aqui. Só o cancelamento de eco pode divergir: a
 * supressão do navegador já está desligada sob o filtro. Reabrir o microfone
 * mantém o processador, que recebe a track nova.
 */
async function setEchoUnderFilter(room: Room, track: LocalAudioTrack, echoCancellation: boolean): Promise<void> {
  const processing: CaptureProcessing = { noiseSuppression: false, echoCancellation };
  room.options.audioCaptureDefaults = { ...room.options.audioCaptureDefaults, ...captureOptionsFor(processing) };
  if (requestedProcessing(track.constraints).echoCancellation === echoCancellation) return;
  await track.restartTrack({ ...track.constraints, ...captureOptionsFor(processing) });
}

async function reconcile(
  room: Room,
  track: LocalAudioTrack | null,
  wanted: boolean,
  echoCancellation: boolean,
  memory: FilterMemory,
): Promise<NoiseFilterStatus> {
  const attached = track?.getProcessor()?.name;
  const hasKrisp = attached === KRISP_PROCESSOR_NAME;
  const hasRnnoise = attached === RNNOISE_PROCESSOR_NAME;

  if (!wanted) {
    if (track !== null && (hasKrisp || hasRnnoise)) await track.stopProcessor();
    await setCapture(room, track, { noiseSuppression: false, echoCancellation });
    return 'off';
  }

  const rnnoiseUsable = !memory.rnnoiseFailed && isRnnoiseSupported();

  // Sem microfone no ar, só dá para preparar a PRÓXIMA captura: crua se o
  // RNNoise vai cuidar dela, já filtrada pelo navegador se não vai.
  if (track === null) {
    await setCapture(room, null, { noiseSuppression: !rnnoiseUsable, echoCancellation });
    return rnnoiseUsable || !memory.krispRejected ? 'idle' : 'browser';
  }
  if (hasKrisp || hasRnnoise) {
    await setEchoUnderFilter(room, track, echoCancellation);
    return hasKrisp ? 'krisp' : 'rnnoise';
  }

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
      await setCapture(room, track, { noiseSuppression: false, echoCancellation });
      await track.setProcessor(new RnnoiseProcessor());
      return 'rnnoise';
    } catch {
      memory.rnnoiseFailed = true;
    }
  }

  await setCapture(room, track, { noiseSuppression: true, echoCancellation });
  return 'browser';
}

/**
 * Supressão de ruído do microfone na sala LiveKit: Krisp quando o servidor
 * autoriza, RNNoise quando não, e a do navegador se nenhum dos dois subir.
 *
 * É o ÚNICO dono das constraints `noiseSuppression` e `echoCancellation`
 * nesta sala — o painel de configurações só grava as preferências
 * (`NOISE_SUPPRESSION_EVENT`, `ECHO_CANCELLATION_EVENT`). Com dois
 * donos, o filtro do navegador voltava a ligar por baixo do filtro de IA a
 * cada troca, e a voz passava por dois filtros em série.
 */
export function useNoiseFilter(): NoiseFilterStatus {
  const room = useRoomContext();
  const { microphoneTrack } = useLocalParticipant();
  const track = microphoneTrack?.track instanceof LocalAudioTrack ? microphoneTrack.track : null;

  const [wanted, setWanted] = useState(readNoiseSuppression);
  const [echoCancellation, setEchoCancellation] = useState(readEchoCancellation);
  const [status, setStatus] = useState<NoiseFilterStatus>(() => (readNoiseSuppression() ? 'idle' : 'off'));
  const memory = useRef<FilterMemory>({ krispRejected: false, rnnoiseFailed: false });
  // Uma troca por vez: ligar e desligar rápido não pode intercalar
  // `setProcessor` com `stopProcessor` na mesma track.
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const handle = (event: Event): void => {
      setWanted((event as CustomEvent<boolean>).detail);
    };
    const handleEcho = (event: Event): void => {
      setEchoCancellation((event as CustomEvent<boolean>).detail);
    };
    window.addEventListener(NOISE_SUPPRESSION_EVENT, handle);
    window.addEventListener(ECHO_CANCELLATION_EVENT, handleEcho);
    return () => {
      window.removeEventListener(NOISE_SUPPRESSION_EVENT, handle);
      window.removeEventListener(ECHO_CANCELLATION_EVENT, handleEcho);
    };
  }, []);

  useEffect(() => {
    let current = true;
    queue.current = queue.current
      .then(() => reconcile(room, track, wanted, echoCancellation, memory.current))
      .then((next) => {
        if (current) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [room, track, wanted, echoCancellation]);

  return status;
}
