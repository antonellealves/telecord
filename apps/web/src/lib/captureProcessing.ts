import type { AudioCaptureOptions } from 'livekit-client';

/**
 * O pedaço de `LocalAudioTrack` que a troca usa. Estreito de propósito: o
 * teste finge um navegador com quatro métodos, sem subir o LiveKit.
 */
export interface CaptureTrack {
  /** A track CRUA do microfone — só vale com a track sem processador. */
  mediaStreamTrack: Pick<MediaStreamTrack, 'getSettings'>;
  constraints: MediaTrackConstraints;
  applyConstraints(constraints: AudioCaptureOptions): Promise<void>;
  restartTrack(options?: AudioCaptureOptions): Promise<void>;
}

/** O processamento de voz DO NAVEGADOR que o app liga e desliga na captura. */
export interface CaptureProcessing {
  noiseSuppression: boolean;
  /**
   * No Chrome o cancelamento de eco custa o agudo: medido com ruído rosa, a
   * captura sai plana até 20 kHz sem ele e, com ele, perde 15 dB entre 14 e
   * 16 kHz e tudo acima disso. Só compensa para quem ouve por caixa de som.
   */
  echoCancellation: boolean;
}

/**
 * As opções de captura que pedem esse processamento.
 *
 * `voiceIsolation` (o filtro do sistema operacional, que o LiveKit pede por
 * padrão) acompanha a supressão de ruído: é a mesma coisa com outro nome.
 */
export function captureOptionsFor(processing: CaptureProcessing): AudioCaptureOptions {
  return {
    noiseSuppression: processing.noiseSuppression,
    voiceIsolation: processing.noiseSuppression,
    echoCancellation: processing.echoCancellation,
  };
}

/**
 * Deixa um microfone já aberto com o processamento pedido.
 *
 * `applyConstraints` é o caminho barato, e no Firefox basta. No Chrome (e no
 * app de computador, que é Chromium) ele resolve com sucesso e não muda nada:
 * medido com o mesmo áudio antes e depois, o processamento continua como
 * nasceu na captura. Então o resultado é CONFERIDO em `getSettings`, e se o
 * navegador não obedeceu, o microfone é reaberto com as constraints novas — o
 * único jeito que funciona nele. É um corte de alguns milissegundos na voz.
 */
export async function applyCaptureProcessing(track: CaptureTrack, processing: CaptureProcessing): Promise<void> {
  // `undefined` é navegador que não informa aquele estado: não conta como
  // divergência, porque não há como conferir depois.
  const diverges = (): boolean => {
    const settings = track.mediaStreamTrack.getSettings();
    return (
      settings.noiseSuppression === !processing.noiseSuppression ||
      settings.echoCancellation === !processing.echoCancellation
    );
  };
  const settings = track.mediaStreamTrack.getSettings();
  const unknown = settings.noiseSuppression === undefined || settings.echoCancellation === undefined;
  if (!diverges() && !unknown) return;

  // `applyConstraints` troca o conjunto inteiro — mescla para não perder
  // dispositivo, taxa de amostragem e o resto do que já foi pedido.
  const wanted: AudioCaptureOptions = { ...track.constraints, ...captureOptionsFor(processing) };
  await track.applyConstraints(wanted).catch(() => undefined);

  if (!diverges()) return;
  await track.restartTrack(wanted);
}
