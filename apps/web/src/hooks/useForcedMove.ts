import { useEffect, useRef } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';

/**
 * Obedece a um "mover para outra sala" vindo da administração.
 *
 * ## Por que isto precisa existir
 *
 * O protocolo do LiveKit não tem "mover": o que o servidor consegue fazer é
 * DESCONECTAR. Quem decide para onde ir é o cliente, e a única informação que
 * sobrevive ao corte é o `metadata` gravado no participante um instante antes
 * (ver `ModerationService.moveParticipant`).
 *
 * Então a sequência é: a administração grava `{ moverPara }` no metadata e
 * desconecta; este hook viu o metadata chegar, guardou o destino, e ao cair
 * navega para lá em vez de mostrar a tela de "conexão perdida".
 *
 * O destino é guardado num ref, e não em estado: ele é lido DEPOIS da
 * desconexão, quando um re-render já não viria a tempo de ajudar.
 */
export function useForcedMove(navigate: (roomId: string) => void): void {
  const room = useRoomContext();
  const destinoRef = useRef<string | null>(null);

  useEffect(() => {
    const lerMetadata = (metadata: string | undefined): void => {
      if (metadata === undefined || metadata === '') return;
      try {
        const parsed: unknown = JSON.parse(metadata);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'moverPara' in parsed &&
          typeof (parsed as { moverPara: unknown }).moverPara === 'string'
        ) {
          destinoRef.current = (parsed as { moverPara: string }).moverPara;
        }
      } catch {
        // Metadata é campo livre: qualquer coisa que não seja o nosso JSON
        // simplesmente não é uma ordem de mover.
      }
    };

    const aoDesconectar = (): void => {
      const destino = destinoRef.current;
      if (destino !== null) {
        destinoRef.current = null;
        navigate(destino);
      }
    };

    lerMetadata(room.localParticipant.metadata);
    room.localParticipant.on('participantMetadataChanged', lerMetadata);
    room.on(RoomEvent.Disconnected, aoDesconectar);
    return () => {
      room.localParticipant.off('participantMetadataChanged', lerMetadata);
      room.off(RoomEvent.Disconnected, aoDesconectar);
    };
  }, [room, navigate]);
}
