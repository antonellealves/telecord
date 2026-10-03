import {
  TrackEvent,
  VideoPresets,
  type AudioPreset,
  type RemoteTrack,
  type RoomOptions,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoCaptureOptions,
  type VideoEncoding,
} from 'livekit-client';
import { SCREEN_AUDIO_PROFILE, VOICE_PROFILE, type AudioSendProfile } from './audioSendProfile';
import { canCaptureSystemAudio } from './shell';

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
 * 1. Sem `degradationPreference`, o WebRTC escolhe `balanced` e, no primeiro
 *    aperto de CPU ou banda, derruba a RESOLUÇÃO — e ela não volta sozinha
 *    com a mesma pressa. É a causa mais comum de "abri em 1080 e virou 720".
 * 2. `resolution` vira `ideal` nas constraints, que é um pedido, não um piso.
 *
 * Os dois são tratados em `screenShareCaptureOptions` e nas opções de
 * publicação.
 *
 * ## E a fluidez
 *
 * Bitrate alto compra nitidez e COBRA fluidez: o tamanho de um quadro-chave
 * cresce junto com o teto, e é o quadro-chave que engasga a imagem quando
 * demora a atravessar a rede. Os tetos abaixo ficam perto do ponto em que
 * mais bitrate já não se vê, para caber com folga no SFU e na descida de quem
 * assiste. A outra metade está do lado de quem recebe — ver
 * `SCREEN_PLAYOUT_DELAY_SECONDS`.
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
    hint: 'Padrão. Texto fino legível e movimento fluido; ~12 Mbps de subida.',
    width: 1920,
    height: 1080,
    fps: 60,
    /*
     * 12 Mbps, e não os 20 que já estiveram aqui.
     *
     * Em 1080p60 com VP9, 12 Mbps é ~2x o que uma transmissão de jogo usa:
     * acima disso o ganho de imagem some e o custo não. Cada Mbps a mais
     * engorda o quadro-chave, que é o que trava a imagem quando demora a
     * chegar, e é multiplicado por cada pessoa assistindo na saída do SFU.
     * A 20 Mbps, três espectadores já pediam 60 Mbps de uma VM pequena.
     */
    bitrate: 12_000_000,
  },
  {
    /*
     * O teto mais alto que ainda atravessa a rede em ritmo constante.
     *
     * Já foi 50 Mbps. Esse número só fazia sentido no papel: por espectador,
     * é mais do que uma VM pequena repassa em ritmo constante e mais do que
     * muita conexão doméstica desce — nitidez de sobra com a imagem
     * engasgando. 25 Mbps em 1440p60 continua sem artefato visível.
     *
     * O controle de congestionamento continua valendo: em rede que não
     * aguenta, o encoder desce sozinho. Este número é um TETO, não um piso.
     */
    id: 'maxima',
    label: 'Resolução original · 60 fps — sem compressão visível',
    hint: 'Sem redimensionar: 1440p ou 4K nativos. Exige ~25 Mbps de subida, e o mesmo de descida de quem assiste.',
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

function audioPreset(profile: AudioSendProfile): AudioPreset {
  return { maxBitrate: profile.maxBitrate, priority: 'high' };
}

/**
 * Voz. Bitrate, RED e DTX vêm de `VOICE_PROFILE` (`audioSendProfile.ts`), que
 * explica a escolha e é o que a auditoria do sender confere.
 *
 * O servidor LiveKit responde `maxaveragebitrate=510000` no SDP, então é o
 * `maxBitrate` do sender que manda de fato no encoder.
 */
export const VOICE_PRESET: AudioPreset = audioPreset(VOICE_PROFILE);

/**
 * Opções de publicação da TELA, que o SDK aplica também ao áudio dela.
 *
 * Sem `audioPreset` e `red` aqui, o áudio da tela herdava o perfil da voz dos
 * `publishDefaults` — RED incluído, porque `red: true` explícito vence o
 * padrão do SDK de desligar RED em estéreo.
 */
export function screenSharePublishOptions(quality: ScreenQualityId = DEFAULT_SCREEN_QUALITY): TrackPublishOptions {
  return {
    screenShareEncoding: screenEncoding(quality),
    degradationPreference: 'maintain-resolution',
    audioPreset: audioPreset(SCREEN_AUDIO_PROFILE),
    red: SCREEN_AUDIO_PROFILE.red,
    dtx: SCREEN_AUDIO_PROFILE.dtx,
    forceStereo: SCREEN_AUDIO_PROFILE.stereo,
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
    /*
     * DTX desligado: ele corta o envio em trecho que o encoder julga
     * silencioso, e o custo aparece no começo de cada frase (ataque de
     * consoante engolido) e em fala baixa tratada como silêncio. Mesma decisão
     * do mediasoup (`hooks/mediasoup/audioProfile.ts`).
     */
    dtx: VOICE_PROFILE.dtx,
    // Redundância de pacote (RED): uma perda vira áudio íntegro em vez de um
    // "tec" no meio da palavra. Dobra o custo de rede da voz.
    red: VOICE_PROFILE.red,
    audioPreset: VOICE_PRESET,
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
    /*
     * O áudio da aba só existe em Chromium desktop; quando vier, sobe sem
     * processamento de voz — o AEC destruiria o áudio do conteúdo.
     *
     * Suprimido inteiramente quando rodando dentro do shell Electron no
     * macOS: lá não existe `audio: 'loopback'` (ver desktop/src/main/
     * index.ts, `audioModeFor`), e pedir áudio mesmo assim só resultaria
     * num prompt do sistema pedindo algo que o shell nunca vai entregar —
     * pior do que simplesmente não perguntar.
     */
    ...(canCaptureSystemAudio()
      ? {
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            /*
             * Tira da captura o som que a PRÓPRIA página toca — a voz da sala
             * e o soundboard. Sem isto, "tela inteira com áudio" pega o mix
             * do sistema com a saída do telecord dentro, e a sala volta como
             * eco. Diferente de mutar a track, preserva todo o resto do som
             * do computador. Navegador que não conhece ignora a constraint, e
             * aí entra a reserva em `useScreenShares`.
             */
            ...({ restrictOwnAudio: true } as Record<string, unknown>),
          },
        }
      : {}),
    /*
     * `motion` — porque é o que roda de qualquer jeito.
     *
     * Aqui já esteve `text`, e nunca valeu: ao publicar tela com codec SVC
     * (o VP9 dos `publishDefaults`), o livekit-client troca a dica para
     * `motion` e fixa três camadas temporais (L1T3), por cima do que foi
     * pedido. O motivo é dele: no caminho de "tela" do Chrome, VP9 com
     * camadas temporais não passa de 5 quadros por segundo. Ver
     * `publishTrack` em LocalParticipant.ts do SDK.
     *
     * Declarar `motion` não muda o que sai no fio; muda que este arquivo
     * para de afirmar uma configuração que não existe. O que segura a
     * nitidez é o `degradationPreference: 'maintain-resolution'` das opções
     * de publicação (que o SDK respeita) e o bitrate do nível — não a dica.
     */
    contentHint: 'motion',
    /*
     * `resolution` é o pedido de captura, e o LiveKit o traduz para `ideal`.
     *
     * `ideal` é um pedido, não um piso — mas trocar por `exact` seria pior: um
     * monitor 1600×900 não consegue entregar 1080 de altura, e `exact` ali não
     * degrada, FALHA. A pessoa clicaria em compartilhar e não sairia nada.
     *
     * O que garante a nitidez não é forçar a captura, e sim o que vem depois:
     * o bitrate de `screenEncoding` e o
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

/**
 * Folga do buffer de recepção da TELA, em segundos.
 *
 * ## O sintoma
 *
 * A transmissão corre e, de tempos em tempos, dá uma travadinha e segue.
 *
 * ## De onde vem
 *
 * O navegador reproduz vídeo WebRTC com o MENOR atraso que consegue — o certo
 * para uma conversa. Só que um stream de tela não chega em ritmo constante:
 * um quadro-chave (o codificador emite periodicamente, e mais um a cada perda
 * que a retransmissão não cobre) pesa dezenas de vezes um quadro comum e leva
 * vários intervalos de quadro para atravessar a rede; o SFU, numa VM pequena,
 * também entrega em rajadas. Sem folga, cada atraso desses vira imagem parada
 * até o quadro chegar inteiro.
 *
 * ## O que isto faz
 *
 * Pede ao receptor que segure sempre ~250 ms de vídeo. O atraso extra é
 * constante, e para quem ASSISTE uma tela não se percebe; em troca, o que
 * chegar até 250 ms atrasado é exibido na hora certa em vez de engasgar.
 *
 * Vale só para a tela e o áudio DELA, que saem no mesmo fluxo e precisam andar
 * juntos. A voz fica de fora: numa conversa, 250 ms a mais é gente falando por
 * cima uma da outra.
 */
export const SCREEN_PLAYOUT_DELAY_SECONDS = 0.25;

/** Aplica a folga acima a uma track remota de tela (vídeo ou áudio dela). */
export function applyScreenPlayoutDelay(track: RemoteTrack): void {
  const receiver = track.receiver;
  if (receiver === undefined) {
    return;
  }
  if ('playoutDelayHint' in receiver) {
    // Chromium. O SDK zera a dica sozinho quando a track acaba.
    track.setPlayoutDelay(SCREEN_PLAYOUT_DELAY_SECONDS);
    return;
  }
  // Firefox e Safari só têm o nome padronizado, em milissegundos — e aqui a
  // limpeza é nossa: o receptor é reaproveitado pela próxima track que chegar
  // na mesma linha do SDP, e sem zerar a folga iria junto para uma câmera.
  receiver.jitterBufferTarget = SCREEN_PLAYOUT_DELAY_SECONDS * 1000;
  track.once(TrackEvent.Ended, () => {
    receiver.jitterBufferTarget = null;
  });
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
