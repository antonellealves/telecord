import { useCallback, useEffect, useRef, useState } from 'react';

export interface MediasoupAwayControls {
  isAway: boolean;
  isBusy: boolean;
  toggle: () => void;
}

export interface MediasoupAwayOptions {
  isMicrophoneEnabled: boolean;
  isCameraOn: boolean;
  silenceMicrophone: () => void;
  stopCamera: () => void;
}

/** Dispara quando o valor passa de falso para verdadeiro, e só então. */
function useTurnedOn(value: boolean, onTurnOn: () => void): void {
  const previous = useRef(value);
  const handler = useRef(onTurnOn);
  handler.current = onTurnOn;

  useEffect(() => {
    const was = previous.current;
    previous.current = value;
    if (value && !was) handler.current();
  }, [value]);
}

/**
 * Ausência declarada, no transporte mediasoup.
 *
 * Diferente de `useAway` (LiveKit): o estado é LOCAL a este navegador, não
 * sincronizado com os outros participantes. O LiveKit tem atributo de
 * participante nativo (`setAttributes`, entregue a todo mundo pelo próprio
 * SFU); o roster do mediasoup (`PeerInfo.mediasoup`) hoje só carrega tracks
 * publicadas, sem um campo de atributo livre — ver
 * `MediasoupConnection.setAttributes`, que está reservado para quando esse
 * campo existir no protocolo. Até lá, "ausente" aparece só para quem marcou,
 * não para os outros na lista de participantes.
 */
export function useMediasoupAway({
  isMicrophoneEnabled,
  isCameraOn,
  silenceMicrophone,
  stopCamera,
}: MediasoupAwayOptions): MediasoupAwayControls {
  const [isAway, setIsAway] = useState(false);

  const toggle = useCallback(() => {
    if (!isAway) {
      if (isMicrophoneEnabled) silenceMicrophone();
      if (isCameraOn) stopCamera();
    }
    setIsAway((current) => !current);
  }, [isAway, isMicrophoneEnabled, isCameraOn, silenceMicrophone, stopCamera]);

  const clearIfAway = useCallback(() => {
    setIsAway(false);
  }, []);

  useTurnedOn(isMicrophoneEnabled, clearIfAway);
  useTurnedOn(isCameraOn, clearIfAway);

  return { isAway, isBusy: false, toggle };
}
