import {
  AudioPresets,
  ScreenSharePresets,
  VideoPresets,
  type RoomOptions,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoCaptureOptions,
} from 'livekit-client';

/**
 * Níveis de qualidade da transmissão de tela.
 *
 * O padrão deixou de ser 1080p15 e passou a ser 1080p30: 15 quadros bastam
 * para slide e código parado, e é exatamente onde a escolha antiga estava
 * certa, mas qualquer coisa em movimento — rolar uma página, um vídeo, um
 * jogo — fica em soluços a 15fps. O dobro de quadros custa o dobro de banda
 * (2,5 → 5 Mbps), e quem não tem essa banda agora tem onde baixar.
 *
 * `original` não redimensiona: entrega a resolução nativa da tela escolhida,
 * que num monitor 1440p ou 4K é o único jeito de texto pequeno chegar legível
 * do outro lado. É o teto, não o padrão — 7 Mbps não é para toda conexão.
 */
export type ScreenQualityId = 'suave' | 'equilibrada' | 'alta' | 'maxima';

export interface ScreenQualityOption {
  id: ScreenQualityId;
  label: string;
  /** Uma linha, para a pessoa escolher sem precisar saber o que é bitrate. */
  hint: string;
  preset: (typeof ScreenSharePresets)[keyof typeof ScreenSharePresets];
}

export const SCREEN_QUALITY_OPTIONS: ScreenQualityOption[] = [
  {
    id: 'suave',
    label: '720p · 15 fps',
    hint: 'Para conexão apertada. Texto continua legível; movimento trava.',
    preset: ScreenSharePresets.h720fps15,
  },
  {
    id: 'equilibrada',
    label: '1080p · 15 fps',
    hint: 'Boa para slide e código parado. Movimento fica em soluços.',
    preset: ScreenSharePresets.h1080fps15,
  },
  {
    id: 'alta',
    label: '1080p · 30 fps',
    hint: 'Padrão. Movimento fluido, ~5 Mbps de subida.',
    preset: ScreenSharePresets.h1080fps30,
  },
  {
    id: 'maxima',
    label: 'Resolução original · 30 fps',
    hint: 'Sem redimensionar: 1440p ou 4K saem nativos. Exige ~7 Mbps.',
    preset: ScreenSharePresets.original,
  },
];

export const DEFAULT_SCREEN_QUALITY: ScreenQualityId = 'alta';

export function screenQuality(id: ScreenQualityId): ScreenQualityOption {
  return (
    SCREEN_QUALITY_OPTIONS.find((option) => option.id === id) ??
    SCREEN_QUALITY_OPTIONS.find((option) => option.id === DEFAULT_SCREEN_QUALITY) ??
    SCREEN_QUALITY_OPTIONS[2]!
  );
}

/** SPEC §6.1. */
export const roomOptions: RoomOptions = {
  adaptiveStream: true,
  dynacast: true,
  publishDefaults: {
    dtx: true,
    red: true,
    /*
     * `musicHighQuality` (96 kbps) no lugar de `speech` (24 kbps).
     *
     * O preset `speech` é afinado para inteligibilidade em banda estreita, e
     * a 24 kbps o Opus já corta a parte de cima do espectro — é o que faz voz
     * soar "de telefone". A 96 kbps ela chega com o brilho que o microfone
     * captou, e a diferença é audível em qualquer fone meia-boca.
     *
     * O custo é de 72 kbps por pessoa FALANDO, e não por pessoa na sala: com
     * `dtx` ligado, quem está calado não manda praticamente nada. Numa sala de
     * 20 com 3 pessoas conversando, são ~220 kbps a mais no total.
     *
     * Mono continua (ver `channelCount` abaixo): voz não tem o que estereofonar,
     * e o estéreo só dobraria a conta.
     */
    audioPreset: AudioPresets.musicHighQuality,
    stopMicTrackOnMute: false,
    videoCodec: 'vp8',
    screenShareEncoding: screenQuality(DEFAULT_SCREEN_QUALITY).preset.encoding,
    simulcast: false,
  },
  audioCaptureDefaults: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    /*
     * Pede ao navegador para não reamostrar para 16 kHz antes de entregar.
     * Sem isto, subir o bitrate do Opus não adianta: o que chega ao codec já
     * vem sem as frequências altas, e o que se ganha é um arquivo maior com o
     * mesmo som abafado.
     */
    sampleRate: 48000,
  },
};

/**
 * Opções de captura de tela para um nível de qualidade.
 *
 * SPEC §6.2 e §6.3.
 */
export function screenShareCaptureOptions(
  quality: ScreenQualityId = DEFAULT_SCREEN_QUALITY,
): ScreenShareCaptureOptions {
  const option = screenQuality(quality);
  return {
    // O áudio da aba só existe em Chromium desktop; quando vier, sobe sem
    // processamento de voz — o AEC destruiria o áudio do conteúdo.
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    /*
     * `motion`, e não `detail`.
     *
     * A dica diz ao codificador o que preservar quando a banda aperta:
     * `detail` sacrifica quadros para manter cada pixel nítido, que é o certo
     * para slide parado e o errado para qualquer coisa que se mexe — e era o
     * que fazia vídeo e jogo compartilhados virarem apresentação de slides.
     * `motion` mantém a fluidez, que é o que a maioria dos compartilhamentos
     * aqui quer.
     */
    contentHint: 'motion',
    // `original` tem resolução 0x0, que significa "não redimensione". Passar
    // isso adiante quebraria a captura, então nesse nível não se pede nada.
    ...(option.preset.width > 0 ? { resolution: option.preset.resolution } : {}),
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    // 'exclude' faz o navegador oferecer só o áudio da aba/janela escolhida,
    // em vez do som do sistema inteiro — sem isso, notificação e qualquer outro
    // programa entram junto na sala.
    systemAudio: 'exclude',
  };
}

/** SPEC §6.9. */
export const cameraCaptureOptions: VideoCaptureOptions = {
  resolution: VideoPresets.h720.resolution,
  facingMode: 'user',
};

/**
 * Simulcast SÓ na câmera.
 *
 * As opções de publicação são passadas por chamada em `setCameraEnabled`, e
 * não nos defaults do Room, de propósito: assim a tela compartilhada mantém a
 * decisão da §6.4 de publicar uma camada só. Câmera é o caso oposto — muitos
 * assistindo em quadro pequeno —, e as camadas menores são o que permite ao
 * SFU mandar pouco para quem não está olhando de perto.
 *
 * A camada de topo subiu de 360p para 720p: 360p era defensável quando a
 * câmera só aparecia em miniatura, mas ela também é aberta em quadro grande, e
 * ali 360p esticado fica borrado. Com simulcast, quem está vendo pequeno
 * continua recebendo 180p — o custo extra é só de quem está olhando de perto.
 */
export const cameraPublishOptions: TrackPublishOptions = {
  simulcast: true,
  videoEncoding: VideoPresets.h720.encoding,
  videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
};

/** Slug curto e digitável para quando o campo de sala vem vazio. */
export function generateRoomId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let value = 0;
  for (const byte of bytes) {
    value = value * 256 + byte;
  }
  return `sala-${value.toString(36).padStart(6, '0').slice(-6)}`;
}
