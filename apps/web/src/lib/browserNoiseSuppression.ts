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

/**
 * Liga ou desliga a supressão de ruído DO NAVEGADOR num microfone já aberto.
 *
 * `applyConstraints` é o caminho barato, e no Firefox basta. No Chrome (e no
 * app de computador, que é Chromium) ele resolve com sucesso e não muda nada:
 * medido com o mesmo áudio antes e depois, o filtro continua como nasceu na
 * captura. Então o resultado é CONFERIDO em `getSettings`, e se o navegador
 * não obedeceu, o microfone é reaberto com a constraint nova — o único jeito
 * que funciona nele. É um corte de alguns milissegundos na voz, uma vez.
 *
 * `voiceIsolation` (o filtro do sistema operacional, que o LiveKit pede por
 * padrão) acompanha a mesma chave: é supressão de ruído com outro nome.
 */
export async function applyBrowserNoiseSuppression(track: CaptureTrack, enabled: boolean): Promise<void> {
  const reported = (): boolean | undefined => track.mediaStreamTrack.getSettings().noiseSuppression;
  if (reported() === enabled) return;

  // `applyConstraints` troca o conjunto inteiro — mescla para não perder
  // dispositivo, taxa de amostragem e o resto do que já foi pedido.
  const wanted: AudioCaptureOptions = { ...track.constraints, noiseSuppression: enabled, voiceIsolation: enabled };
  await track.applyConstraints(wanted).catch(() => undefined);

  // `undefined` é navegador que não informa o estado: sem como conferir, fica
  // valendo o que o `applyConstraints` tiver feito.
  if (reported() !== !enabled) return;
  await track.restartTrack(wanted);
}
