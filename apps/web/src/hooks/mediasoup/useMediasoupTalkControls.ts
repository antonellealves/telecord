import { useCallback, useEffect, useRef, useState } from 'react';
import { describeMicrophoneError } from '../../lib/errors';
import { readTalkMode, writeTalkMode, type TalkMode } from '../../lib/storage';
import { MIC_CONSTRAINTS } from './audioProfile';
import type { MediasoupEngine } from './useMediasoupEngine';
import { withPublishTimeout } from './withPublishTimeout';

export interface MediasoupTalkControls {
  mode: TalkMode;
  setMode: (mode: TalkMode) => void;
  isBusy: boolean;
  /**
   * Estado OTIMISTA do mic — vira `true`/`false` no instante do clique,
   * antes de qualquer round-trip com o SFU (`getUserMedia`/`produce`). O
   * botão usa isto, não o `isMicrophoneEnabled` derivado do roster (que só
   * muda quando o `publish()` de verdade resolve) — sem isto, clicar tinha
   * uma pausa perceptível antes do ícone reagir, porque esperava a rede.
   */
  isMicOn: boolean;
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
  /**
   * Espelha `desiredRef` em estado React — é o que o botão mostra. Muda no
   * mesmo instante do clique (`setDesired` abaixo), sem esperar
   * `getUserMedia`/`publish()` — só ASSIM o ícone/rótulo reage na hora. O
   * estado real da publicação continua vivo em `engine.connection`
   * (`isMicEnabledNow`, mais embaixo), consultado ao vivo quando `apply`
   * precisa decidir o que fazer — não é mais o que a UI lê para saber se o
   * mic está "ligado".
   */
  const [isMicOn, setIsMicOn] = useState(false);

  const desiredRef = useRef(false);
  const busyRef = useRef(false);
  const applyRef = useRef<() => void>(() => undefined);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const micStreamRef = useRef<MediaStream | null>(null);
  /**
   * Lido de dentro de `apply`/`finish` no lugar de um `isMicEnabled`
   * derivado de prop (`engine.localTracks`) capturado por closure de
   * `useCallback`. Esse valor só reflete a publicação de verdade quando o
   * React RE-RENDERIZA com o `localTracks` novo — o que ainda não tinha
   * acontecido dentro do próprio `.finally()` de `apply()`, então `finish()`
   * podia reentrar numa versão OBSOLETA de `apply` (fechada sobre o
   * `isMicEnabled` de antes do publish), decidir "nada mudou" e nunca
   * desfazer/refazer a publicação direito. Isso deixava um producer de mic
   * ANTIGO vivo no SFU enquanto um clique seguinte criava um producer NOVO
   * por cima — dois producers de áudio ao mesmo tempo (um deles morto, sem
   * nunca mandar bytes), e o outro participante podia acabar assinando o
   * morto. `engine.connection` é sempre a MESMA instância entre renders
   * (criada uma vez por sala em `useMediasoupEngine`), então ler
   * `localTrackHandles` direto dela agora, e não da prop, dá o estado real
   * no exato instante da chamada, sem depender de o React já ter
   * re-renderizado.
   */
  const isMicEnabledNow = useCallback(
    () => engine.connection?.localTrackHandles.some((track) => track.trackKind === 'mic') ?? false,
    [engine.connection],
  );

  const setDesired = useCallback((next: boolean) => {
    desiredRef.current = next;
    setIsMicOn(next);
  }, []);

  const apply = useCallback(() => {
    if (busyRef.current) return;
    const desired = desiredRef.current;
    const connection = engine.connection;
    if (connection === null || isMicEnabledNow() === desired) return;

    busyRef.current = true;
    setIsBusy(true);

    const finish = (): void => {
      busyRef.current = false;
      setIsBusy(false);
      // Só reprocessa se ALGUÉM pediu outra coisa enquanto isto rodava (ex.:
      // apertou e soltou o "aperte para falar" antes do publish terminar) —
      // `isMicEnabledNow()` já reflete o producer de verdade nesta mesma call
      // stack (ver docstring acima), então esta comparação não reentra com
      // dado obsoleto.
      if (isMicEnabledNow() !== desiredRef.current) applyRef.current();
    };

    if (desired) {
      // OTIMISTA: `getUserMedia`/`produce` rodam em background — o botão já
      // mudou (`setDesired`, chamado por quem pediu isto) antes desta função
      // sequer ser chamada. Se a publicação falhar, `setDesired(false)` no
      // `.catch()` abaixo desfaz o otimismo e mostra o erro.
      navigator.mediaDevices
        .getUserMedia({ audio: MIC_CONSTRAINTS })
        .then(async (stream) => {
          const track = stream.getAudioTracks()[0];
          if (track === undefined) throw new Error('sem track de áudio');
          micStreamRef.current = stream;
          await withPublishTimeout(
            connection.publish(track, 'mic'),
            'Tempo esgotado ao publicar o microfone.',
          );
        })
        .catch((error: unknown) => {
          setDesired(false);
          // A publicação pode ter ficado presa no meio do handshake — solta a
          // track capturada para não deixar o microfone físico "aceso" sem
          // nunca ter sido usado.
          for (const track of micStreamRef.current?.getTracks() ?? []) track.stop();
          micStreamRef.current = null;
          onErrorRef.current(describeMicrophoneError(error));
        })
        .finally(finish);
    } else {
      const producer = connection.localTrackHandles.find((track) => track.trackKind === 'mic') ?? null;
      if (producer !== null) connection.unpublish(producer.producerId);
      for (const track of micStreamRef.current?.getTracks() ?? []) track.stop();
      micStreamRef.current = null;
      finish();
    }
  }, [engine.connection, isMicEnabledNow, setDesired]);
  applyRef.current = apply;

  const pressToTalk = useCallback(() => {
    setDesired(true);
    applyRef.current();
  }, [setDesired]);

  const releaseToTalk = useCallback(() => {
    setDesired(false);
    applyRef.current();
  }, [setDesired]);

  const silence = releaseToTalk;

  const toggleOpenMic = useCallback(() => {
    setDesired(!desiredRef.current);
    applyRef.current();
  }, [setDesired]);

  const setMode = useCallback(
    (next: TalkMode) => {
      setModeState(next);
      writeTalkMode(next);
      if (next === 'push') {
        setDesired(false);
        applyRef.current();
      }
    },
    [setDesired],
  );

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

  return { mode, setMode, isBusy, isMicOn, toggleOpenMic, pressToTalk, releaseToTalk, silence };
}
