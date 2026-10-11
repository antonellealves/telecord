import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';

/** É por este nome que `useNoiseFilter` reconhece o filtro numa track. */
export const RNNOISE_PROCESSOR_NAME = 'telecord-rnnoise';

/**
 * A rede do RNNoise foi treinada em 48 kHz e o worklet do pacote assume
 * exatamente isso. Por isso o filtro roda num AudioContext PRÓPRIO, nessa
 * taxa, e não no que o LiveKit entrega — que segue a placa de som e pode ser
 * 44,1 kHz. O navegador reamostra na entrada e na saída.
 */
const SAMPLE_RATE = 48_000;

/** Baixar ~200 KB e subir o grafo leva dezenas de milissegundos; isto é teto para rede ruim. */
const START_TIMEOUT_MS = 8_000;
/** Quanto silêncio passa pelo filtro depois do tom de teste, para ele não vazar na voz. */
const FLUSH_MS = 150;

export function isRnnoiseSupported(): boolean {
  return (
    typeof AudioContext !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof MediaStreamAudioDestinationNode !== 'undefined' &&
    typeof WebAssembly !== 'undefined'
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** O binário é o mesmo para todo mundo na página: baixa uma vez só. */
let binary: Promise<ArrayBuffer> | null = null;

function loadBinary(): Promise<ArrayBuffer> {
  if (binary === null) {
    const loading = loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).then((bytes) => {
      /*
       * `loadRnnoise` não confere a resposta. Um arquivo que sumiu num deploy
       * novo volta como o index.html da SPA, com status 200 — e o worklet,
       * recebendo HTML no lugar do WebAssembly, falha calado e deixa o
       * microfone mudo. Conferir aqui transforma isso em erro de verdade.
       */
      if (!WebAssembly.validate(bytes)) throw new Error('O arquivo do RNNoise não é WebAssembly.');
      return bytes;
    });
    // Falhou: a próxima tentativa baixa de novo em vez de herdar o erro.
    loading.catch(() => {
      if (binary === loading) binary = null;
    });
    binary = loading;
  }
  return binary;
}

/**
 * Espera o filtro devolver áudio de verdade antes de entregar a voz a ele.
 *
 * O worklet do pacote carrega o WebAssembly por conta própria, depois de
 * criado, e enquanto não termina devolve silêncio — se o carregamento falhar
 * lá dentro, devolve silêncio para sempre e ninguém fica sabendo. Um tom de
 * teste distingue os dois casos: saiu qualquer coisa diferente de zero, o
 * filtro está vivo.
 */
async function waitUntilAlive(context: AudioContext, node: AudioNode, deadline: number): Promise<void> {
  const tone = new OscillatorNode(context, { frequency: 1_000 });
  const level = new GainNode(context, { gain: 0.1 });
  const meter = new AnalyserNode(context, { fftSize: 256 });
  const samples = new Float32Array(meter.fftSize);
  tone.connect(level).connect(node);
  node.connect(meter);
  tone.start();
  try {
    for (;;) {
      meter.getFloatTimeDomainData(samples);
      if (samples.some((sample) => sample !== 0)) break;
      if (performance.now() > deadline) throw new Error('O RNNoise não começou a processar.');
      await sleep(20);
    }
    // O filtro guarda alguns milissegundos do que entrou. Empurra silêncio
    // por ele para o resto do tom não sair junto com a primeira palavra.
    level.gain.value = 0;
    await sleep(FLUSH_MS);
  } finally {
    tone.stop();
    level.disconnect();
    node.disconnect(meter);
  }
}

/**
 * Supressão de ruído por rede neural (RNNoise, o modelo do Xiph usado no OBS
 * e no Mumble), como processador de track do LiveKit.
 *
 * Existe porque o Krisp, o filtro que o LiveKit oferece, só é licenciado no
 * LiveKit Cloud; num servidor próprio sobrava o filtro do navegador, que
 * apaga pedaço de sílaba junto com o ruído — o som "robotizado". Medido com
 * voz gravada num quarto com ventilador e teclado, o RNNoise deixou o fundo
 * uns 10 dB mais limpo e comeu menos da metade das sílabas.
 *
 * Quem liga este processador precisa entregar o microfone CRU (sem a
 * supressão do navegador): dois filtros em série somam os defeitos dos dois.
 * Cancelamento de eco e ganho automático continuam por conta do navegador.
 */
export class RnnoiseProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  readonly name = RNNOISE_PROCESSOR_NAME;
  processedTrack?: MediaStreamTrack;

  private context: AudioContext | null = null;
  private node: RnnoiseWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  init = async (opts: AudioProcessorOptions): Promise<void> => {
    try {
      await this.start(opts.track);
    } catch (error) {
      await this.destroy();
      throw error;
    }
  };

  /** O LiveKit chama ao reabrir o microfone (troca de aparelho): mesma saída, entrada nova. */
  restart = async (opts: AudioProcessorOptions): Promise<void> => {
    if (this.context === null || this.node === null) {
      await this.init(opts);
      return;
    }
    this.connect(opts.track);
  };

  destroy = async (): Promise<void> => {
    this.source?.disconnect();
    this.node?.disconnect();
    // Fechar o contexto é o que de fato solta o worklet e o WebAssembly dele.
    await this.context?.close().catch(() => undefined);
    this.source = null;
    this.node = null;
    this.context = null;
    this.processedTrack = undefined;
  };

  private async start(track: MediaStreamTrack): Promise<void> {
    const deadline = performance.now() + START_TIMEOUT_MS;
    const context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    this.context = context;

    /*
     * Tudo que pode ficar pendurado para sempre corre contra o relógio: o
     * `resume` de um contexto bloqueado pela política de autoplay não rejeita,
     * só não resolve — e o microfone ficaria esperando por ele.
     */
    const ready = (async () => {
      if (context.state !== 'running') await context.resume();
      const [bytes] = await Promise.all([loadBinary(), context.audioWorklet.addModule(rnnoiseWorkletUrl)]);
      return bytes;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('O RNNoise demorou demais para carregar.')), START_TIMEOUT_MS);
    });
    // Se o relógio ganhar, o que `ready` fizer depois não interessa a ninguém.
    ready.catch(() => undefined);
    const bytes = await Promise.race([ready, late]).finally(() => clearTimeout(timer));

    const node = new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary: bytes });
    // Mono de ponta a ponta: microfone que entrega dois canais é somado antes
    // do filtro, em vez de sair com um canal filtrado e o outro vazio.
    node.channelCount = 1;
    node.channelCountMode = 'explicit';
    this.node = node;

    const destination = new MediaStreamAudioDestinationNode(context, { channelCount: 1 });
    node.connect(destination);
    await waitUntilAlive(context, node, deadline);

    const processed = destination.stream.getAudioTracks()[0];
    if (processed === undefined) throw new Error('O RNNoise não produziu uma track de áudio.');
    this.processedTrack = processed;
    this.connect(track);
  }

  private connect(track: MediaStreamTrack): void {
    if (this.context === null || this.node === null) return;
    this.source?.disconnect();
    this.source = this.context.createMediaStreamSource(new MediaStream([track]));
    this.source.connect(this.node);
  }
}
