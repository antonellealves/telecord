/**
 * A fatia de `TrackPublication` (livekit-client) que `CameraStrip` e
 * `ScreenStage` realmente usam: uma track anexável a um elemento de mídia.
 *
 * Existe para os dois componentes pararem de importar o tipo concreto
 * `TrackPublication` do livekit-client — a classe real tem ~30 campos
 * internos que não fazem sentido fora de uma conexão LiveKit, e o transporte
 * `mediasoup` (`hooks/mediasoup/mediasoupTrack.ts`) usa um objeto bem mais
 * simples que não pode ser um `TrackPublication` de verdade sem estender a
 * própria classe do SDK.
 *
 * A real `TrackPublication` do LiveKit satisfaz esta interface
 * ESTRUTURALMENTE (ela é um superconjunto) — nenhum comportamento muda no
 * caminho LiveKit por causa desta troca de tipo, é só uma anotação menos
 * específica no `CameraEntry`/`ScreenShareEntry`.
 */
export interface AttachableTrack {
  attach: (element: HTMLMediaElement) => HTMLMediaElement;
  detach: (element?: HTMLMediaElement) => HTMLMediaElement[];
}

export interface AttachablePublication {
  track?: AttachableTrack | null;
}
