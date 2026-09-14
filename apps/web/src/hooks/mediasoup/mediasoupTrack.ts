/**
 * Envelope mínimo em volta de um `MediaStreamTrack` cru, com `attach`/`detach`
 * no mesmo formato do `Track` do livekit-client — é só essa superfície que
 * `ScreenStage`/`CameraStrip` usam (`entry.publication.track.attach(el)`), e
 * reproduzi-la aqui evita que esses dois componentes precisem saber qual
 * transporte está por trás.
 */
export interface MediasoupTrackHandle {
  mediaStreamTrack: MediaStreamTrack;
  attach: (element: HTMLMediaElement) => HTMLMediaElement;
  detach: (element?: HTMLMediaElement) => HTMLMediaElement[];
}

export function wrapMediaStreamTrack(track: MediaStreamTrack): MediasoupTrackHandle {
  const attachedElements = new Set<HTMLMediaElement>();

  return {
    mediaStreamTrack: track,
    attach(element) {
      let stream = element.srcObject instanceof MediaStream ? element.srcObject : null;
      if (stream === null) {
        stream = new MediaStream();
        element.srcObject = stream;
      }
      if (!stream.getTracks().includes(track)) {
        stream.addTrack(track);
      }
      attachedElements.add(element);
      void element.play().catch(() => undefined);
      return element;
    },
    detach(element) {
      const targets = element === undefined ? [...attachedElements] : [element];
      for (const target of targets) {
        const stream = target.srcObject instanceof MediaStream ? target.srcObject : null;
        stream?.removeTrack(track);
        attachedElements.delete(target);
      }
      return targets;
    },
  };
}
