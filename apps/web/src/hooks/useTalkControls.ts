import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { describeMicrophoneError } from '../lib/errors';
import { readTalkMode, writeTalkMode, type TalkMode } from '../lib/storage';

export interface TalkControls {
  mode: TalkMode;
  setMode: (mode: TalkMode) => void;
  isBusy: boolean;
  /** Voz aberta: liga e desliga. */
  toggleOpenMic: () => void;
  /** Aperte para falar. */
  pressToTalk: () => void;
  releaseToTalk: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA'
  );
}

/**
 * Microfone em dois modos: voz aberta e aperte-para-falar.
 *
 * `setMicrophoneEnabled` é assíncrono e a tecla pode ser solta no meio da
 * chamada. Em vez de disparar uma chamada por evento, o hook guarda o estado
 * DESEJADO e reconcilia ao fim de cada chamada — sem isso, um toque rápido
 * pode terminar com o microfone aberto porque o "liga" resolveu depois do
 * "desliga".
 */
export function useTalkControls(onError: (message: string) => void): TalkControls {
  const room = useRoomContext();
  const [mode, setModeState] = useState<TalkMode>(() => readTalkMode());
  const [isBusy, setIsBusy] = useState(false);

  const desiredRef = useRef(false);
  const busyRef = useRef(false);
  const applyRef = useRef<() => void>(() => undefined);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const apply = useCallback(() => {
    if (busyRef.current) {
      return;
    }
    const desired = desiredRef.current;
    if (room.localParticipant.isMicrophoneEnabled === desired) {
      return;
    }

    busyRef.current = true;
    setIsBusy(true);
    void room.localParticipant
      .setMicrophoneEnabled(desired)
      .catch((error: unknown) => {
        // Falhou (permissão negada, dispositivo ocupado): volta o desejo para
        // "calado", senão a reconciliação abaixo tentaria de novo em loop.
        desiredRef.current = false;
        onErrorRef.current(describeMicrophoneError(error));
      })
      .finally(() => {
        busyRef.current = false;
        setIsBusy(false);
        applyRef.current();
      });
  }, [room]);
  applyRef.current = apply;

  const pressToTalk = useCallback(() => {
    desiredRef.current = true;
    applyRef.current();
  }, []);

  const releaseToTalk = useCallback(() => {
    desiredRef.current = false;
    applyRef.current();
  }, []);

  const toggleOpenMic = useCallback(() => {
    desiredRef.current = !desiredRef.current;
    applyRef.current();
  }, []);

  const setMode = useCallback((next: TalkMode) => {
    setModeState(next);
    writeTalkMode(next);
    // Entrar no modo push começa calado — é o que "aperte para falar" promete.
    if (next === 'push') {
      desiredRef.current = false;
      applyRef.current();
    }
  }, []);

  useEffect(() => {
    if (mode !== 'push') {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || event.repeat || isTypingTarget(event.target)) {
        return;
      }
      // Sem isto, Espaço rola a página e ainda aciona o botão que estiver com
      // foco — inclusive o de sair.
      event.preventDefault();
      pressToTalk();
    };

    const handleKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== 'Space' || isTypingTarget(event.target)) {
        return;
      }
      event.preventDefault();
      releaseToTalk();
    };

    // Trocar de janela com a tecla apertada nunca gera keyup: sem cortar aqui,
    // o microfone ficaria aberto com a pessoa achando que soltou.
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

  return { mode, setMode, isBusy, toggleOpenMic, pressToTalk, releaseToTalk };
}
