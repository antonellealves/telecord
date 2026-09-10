import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { AWAY_ATTRIBUTE, AWAY_VALUE } from '@telecord/shared';

export interface AwayControls {
  /** Chamada em curso ao servidor: o botão espera antes de aceitar outro clique. */
  isBusy: boolean;
  /** Entra ou sai da ausência. Entrar desliga microfone e câmera. */
  toggle: () => void;
}

export interface AwayOptions {
  isMicrophoneEnabled: boolean;
  isCameraOn: boolean;
  silenceMicrophone: () => void;
  stopCamera: () => void;
  onError: (message: string) => void;
}

/** Dispara quando o valor passa de falso para verdadeiro, e só então. */
function useTurnedOn(value: boolean, onTurnOn: () => void): void {
  const previous = useRef(value);
  const handler = useRef(onTurnOn);
  handler.current = onTurnOn;

  useEffect(() => {
    const was = previous.current;
    previous.current = value;
    if (value && !was) {
      handler.current();
    }
  }, [value]);
}

/**
 * Ausência declarada, com os dispositivos desligados junto.
 *
 * O estado NÃO mora aqui: quem está ausente sai do atributo do participante,
 * lido por `useParticipantViews` como qualquer outro campo. Guardar uma cópia
 * local daria duas fontes para o mesmo fato, e elas divergiriam na primeira
 * falha de rede — o botão diria "voltar" para uma sala que continua vendo a
 * pessoa presente.
 *
 * Ausentar-se desliga microfone e câmera porque é isso que a marca promete a
 * quem fica: ninguém precisa perguntar se o outro ainda está ouvindo. Voltar
 * NÃO religa nada — reabrir o microfone de alguém que talvez tenha saído da
 * frente do computador é justamente o acidente que se quer evitar.
 */
export function useAway({
  isMicrophoneEnabled,
  isCameraOn,
  silenceMicrophone,
  stopCamera,
  onError,
}: AwayOptions): AwayControls {
  const room = useRoomContext();
  const [isBusy, setIsBusy] = useState(false);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const publish = useCallback(
    (away: boolean) => {
      setIsBusy(true);
      void room.localParticipant
        // String vazia apaga a chave: é assim que o LiveKit remove um atributo.
        .setAttributes({ [AWAY_ATTRIBUTE]: away ? AWAY_VALUE : '' })
        .catch(() => {
          onErrorRef.current(
            away ? 'Não deu para avisar que você saiu.' : 'Não deu para avisar que você voltou.',
          );
        })
        .finally(() => setIsBusy(false));
    },
    [room],
  );

  const toggle = useCallback(() => {
    // Lê do próprio `Room`, não de uma prop: o clique pode chegar antes da
    // renderização que traria o valor novo, e aí o botão faria o contrário.
    const away = room.localParticipant.attributes[AWAY_ATTRIBUTE] === AWAY_VALUE;
    if (!away) {
      if (isMicrophoneEnabled) silenceMicrophone();
      if (isCameraOn) stopCamera();
    }
    publish(!away);
  }, [room, publish, isMicrophoneEnabled, isCameraOn, silenceMicrophone, stopCamera]);

  /*
   * Reabrir um dispositivo desfaz a ausência: quem está falando ou aparecendo
   * não está ausente, e deixar a marca de pé faria a lista mentir.
   *
   * Só a virada de desligado para ligado conta. Testar o valor corrente
   * cancelaria a própria ausência no ato de entrar nela — no clique o
   * microfone ainda está aberto, e só desliga um instante depois.
   */
  const clearIfAway = useCallback(() => {
    if (room.localParticipant.attributes[AWAY_ATTRIBUTE] === AWAY_VALUE) {
      publish(false);
    }
  }, [room, publish]);

  useTurnedOn(isMicrophoneEnabled, clearIfAway);
  useTurnedOn(isCameraOn, clearIfAway);

  return { isBusy, toggle };
}
