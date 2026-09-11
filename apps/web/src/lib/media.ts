import {
  AudioPresets,
  VideoPresets,
  type RoomOptions,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoCaptureOptions,
  type VideoEncoding,
} from 'livekit-client';

/**
 * Níveis de qualidade da transmissão de tela.
 *
 * ## Por que os presets prontos do LiveKit não servem aqui
 *
 * `ScreenSharePresets.h1080fps30` pede 1920×1080 a 5 Mbps. Parece bastante, e
 * não é: 5 Mbps é a conta para vídeo COMUM, onde o olho perdoa borrão em
 * textura. Tela compartilhada é quase toda texto e linha fina de interface —
 * o conteúdo mais caro que existe para um codificador, porque cada letra é
 * borda de alto contraste. A 5 Mbps o VP8 desiste de resolver os detalhes e o
 * resultado é um 1080p que parece 720p esticado. Daí os níveis abaixo terem
 * bitrate próprio, bem acima do preset.
 *
 * ## O que mais estava contra a nitidez
 *
 * 1. `contentHint: 'motion'` mandava o codificador SACRIFICAR detalhe para
 *    manter quadro. Para tela, é exatamente o contrário do que se quer.
 * 2. Sem `degradationPreference`, o WebRTC escolhe `balanced` e, no primeiro
 *    aperto de CPU ou banda, derruba a RESOLUÇÃO — e ela não volta sozinha
 *    com a mesma pressa. É a causa mais comum de "abri em 1080 e virou 720".
 * 3. `resolution` vira `ideal` nas constraints, que é um pedido, não um piso.
 *
 * Os três são tratados em `screenShareCaptureOptions` e nas opções de
 * publicação.
 */
export type ScreenQualityId = 'suave' | 'equilibrada' | 'alta' | 'maxima';

export interface ScreenQualityOption {
  id: ScreenQualityId;
  label: string;
  /** Uma linha, para a pessoa escolher sem precisar saber o que é bitrate. */
  hint: string;
  /** 0 = não redimensionar; entrega a resolução nativa da tela escolhida. */
  width: number;
  height: number;
  fps: number;
  /** Teto de subida, em bits por segundo. */
  bitrate: number;
}

export const SCREEN_QUALITY_OPTIONS: ScreenQualityOption[] = [
  {
    id: 'suave',
    label: '720p · 30 fps',
    hint: 'Para conexão apertada — cerca de 2,5 Mbps de subida.',
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 2_500_000,
  },
  {
    id: 'equilibrada',
    label: '1080p · 30 fps',
    hint: 'Bom para quase tudo. Cerca de 6 Mbps de subida.',
    width: 1920,
    height: 1080,
    fps: 30,
    bitrate: 6_000_000,
  },
  {
    id: 'alta',
    label: '1080p · 60 fps — nítido',
    hint: 'Padrão. Texto fino legível e movimento fluido; ~12 Mbps.',
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 12_000_000,
  },
  {
    id: 'maxima',
    label: 'Resolução original · 60 fps',
    hint: 'Sem redimensionar: 1440p ou 4K nativos. Exige ~25 Mbps de subida.',
    width: 0,
    height: 0,
    fps: 60,
    bitrate: 25_000_000,
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

/** Encoding de publicação para um nível — o teto que o SFU vai respeitar. */
export function screenEncoding(id: ScreenQualityId): VideoEncoding {
  const option = screenQuality(id);
  return {
    maxBitrate: option.bitrate,
    maxFramerate: option.fps,
    priority: 'high',
  };
}

/** SPEC §6.1. */
export const roomOptions: RoomOptions = {
  /*
   * `pixelDensity: 'screen'` é o que faltava do lado de QUEM ASSISTE.
   *
   * O `adaptiveStream` pede ao SFU um fluxo do tamanho do ELEMENTO na tela, e
   * não do tamanho original. Num quadro de 960px de largura ele pedia ~960px
   * de vídeo — e com `devicePixelRatio` 1 assumido, num monitor de alta
   * densidade isso é metade dos pixels que a tela realmente desenha. O
   * resultado é um 1080p publicado que CHEGA reduzido, e a queixa legítima de
   * que "1080 parece 720" mesmo com a subida certa.
   *
   * Com `'screen'`, o pedido acompanha a densidade real do monitor. Custa
   * banda de descida em tela retina, que é exatamente onde a diferença
   * aparece.
   */
  adaptiveStream: { pixelDensity: 'screen' },
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
    /*
     * VP9, com VP8 de reserva.
     *
     * Para tela cheia de texto, a diferença entre os dois é grande: no mesmo
     * bitrate o VP9 resolve borda de letra que o VP8 borra, e era metade da
     * razão de o 1080p parecer 720p. O VP8 estava aqui por compatibilidade
     * ampla, e `backupCodec` preserva exatamente isso — quem tem navegador
     * sem VP9 recebe a versão VP8 em vez de nada.
     *
     * O custo é CPU de codificação em quem transmite. É o lado certo para
     * gastar: quem compartilha é um, quem assiste são vinte.
     */
    videoCodec: 'vp9',
    backupCodec: { codec: 'vp8' },
    screenShareEncoding: screenEncoding(DEFAULT_SCREEN_QUALITY),
    /*
     * MANTER A RESOLUÇÃO é o que importa numa tela.
     *
     * Sem isto o WebRTC usa `balanced` e, no primeiro aperto de CPU ou banda,
     * derruba a resolução — e ela não volta com a mesma pressa. Era a causa
     * mais comum de começar em 1080p e terminar borrado sem ninguém ter
     * mexido em nada. `maintain-resolution` prefere perder quadro a perder
     * pixel, que para texto é a troca certa.
     */
    degradationPreference: 'maintain-resolution',
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
     * `text`, e não `motion`.
     *
     * A dica diz ao codificador o que sacrificar quando aperta. `motion` —
     * que eu tinha posto aqui antes — manda jogar DETALHE fora para segurar o
     * quadro, e numa tela cheia de texto isso é exatamente o avesso do que se
     * quer: é o que fazia o 1080p chegar com cara de 720p esticado.
     *
     * `text` é a dica específica para captura de tela, e `detail` é o nome
     * antigo dela. Nenhuma das duas congela a imagem em movimento: o que elas
     * mudam é a ORDEM do sacrifício, e com o bitrate destes níveis não há
     * sacrifício a fazer na maior parte do tempo.
     */
    contentHint: 'text',
    /*
     * `resolution` é o pedido de captura, e o LiveKit o traduz para `ideal`.
     *
     * `ideal` é um pedido, não um piso — mas trocar por `exact` seria pior: um
     * monitor 1600×900 não consegue entregar 1080 de altura, e `exact` ali não
     * degrada, FALHA. A pessoa clicaria em compartilhar e não sairia nada.
     *
     * O que garante a nitidez não é forçar a captura, e sim o que vem depois:
     * `contentHint: 'text'`, o bitrate alto de `screenEncoding` e o
     * `degradationPreference: 'maintain-resolution'`. Juntos, o que o
     * navegador entregar chega inteiro do outro lado.
     *
     * O nível "máxima" tem largura 0 — "não redimensione" —, e ali nada é
     * pedido: o navegador entrega a resolução nativa da tela escolhida.
     */
    ...(option.width > 0
      ? {
          resolution: {
            width: option.width,
            height: option.height,
            frameRate: option.fps,
          },
        }
      : {}),
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
