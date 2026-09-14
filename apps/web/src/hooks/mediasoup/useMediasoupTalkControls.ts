import { useCallback, useEffect, useRef, useState } from 'react';
import { describeMicrophoneError } from '../../lib/errors';
import { readTalkMode, writeTalkMode, type TalkMode } from '../../lib/storage';
import type { MediasoupEngine } from './useMediasoupEngine';

export interface MediasoupTalkControls {
  mode: TalkMode;
  setMode: (mode: TalkMode) => void;
  isBusy: boolean;
  toggleOpenMic: () => void;
  pressToTalk: () => void;
  releaseToTalk: () => void;
  silence: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA'
  );
}

/**
 * Microfone em dois modos (voz aberta / aperte-para-falar), no mediasoup.
 * Equivalente a `useTalkControls`, sobre `MediasoupConnection.publish`/
 * `unpublish` em vez de `LocalParticipant.setMicrophoneEnabled`.
 */
export function useMediasoupTalkControls(
  engine: MediasoupEngine,
  onError: (message: string) => void,
): MediasoupTalkControls {
  const [mode, setModeState] = useState<TalkMode>(() => readTalkMode());
  const [isBusy, setIsBusy] = useState(false);

  const desiredRef = useRef(false);
  const busyRef = useRef(false);
  const applyRef = useRef<() => void>(() => undefined);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const micStreamRef = useRef<MediaStream | null>(null);

  const isMicEnabled = engine.localTracks.some((track) => track.trackKind === 'mic');

  const apply = useCallback(() => {
    if (busyRef.current) return;
    const desired = desiredRef.current;
    if (isMicEnabled === desired) return;

    const connection = engine.connection;
    if (connection === null) return;

    busyRef.current = true;
    setIsBusy(true);

    const finish = (): void => {
      busyRef.current = false;
      setIsBusy(false);
      applyRef.current();
    };

    if (desired) {
      navigator.mediaDevices
        .getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
            sampleRate: 48_000,
          },
        })
        .then(async (stream) => {
          const track = stream.getAudioTracks()[0];
          if (track === undefined) throw new Error('sem track de áudio');
          micStreamRef.current = stream;
          await connection.publish(track, 'mic');
        })
        .catch((error: unknown) => {
          desiredRef.current = false;
          onErrorRef.current(describeMicrophoneError(error));
        })
        .finally(finish);
    } else {
      const producer = engine.localTracks.find((track) => track.trackKind === 'mic') ?? null;
      if (producer !== null) connection.unpublish(producer.producerId);
      for (const track of micStreamRef.current?.getTracks() ?? []) track.stop();
      micStreamRef.current = null;
      finish();
    }
  }, [engine, isMicEnabled]);
  applyRef.current = apply;

  const pressToTalk = useCallback(() => {
    desiredRef.current = true;
    applyRef.current();
  }, []);

  const releaseToTalk = useCallback(() => {
    desiredRef.current = false;
    applyRef.current();
  }, []);

  const silence = releaseToTalk;

  const toggleOpenMic = useCallback(() => {
    desiredRef.current = !desiredRef.current;
    applyRef.current();
  }, []);

  const setMode = useCallback((next: TalkMode) => {
    setModeState(next);
    writeTalkMode(next);
    if (next === 'push') {
      desiredRef.current = false;
      applyRef.current();
    }
  }, []);

  useEffect(() => {
    if (mode !== 'push') return;

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat || isTypingTarget(event.target)) return;
      event.preventDefault();
      pressToTalk();
    };
    const handleKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) return;
      event.preventDefault();
      releaseToTalk();
    };
    const handleBlur = (): void => releaseToTalk();

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      releaseToTalk();
    };
  }, [mode, pressToTalk, releaseToTalk]);

  return { mode, setMode, isBusy, toggleOpenMic, pressToTalk, releaseToTalk, silence };
}
