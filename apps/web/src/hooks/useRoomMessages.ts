import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { type RemoteParticipant, RoomEvent } from 'livekit-client';
import {
  CHAT_HISTORY_LIMIT,
  MAX_CHAT_LENGTH,
  parseRoomMessage,
  type RoomMessage,
} from '@telecord/shared';
import { useSoundPlayer, type SoundPlayback } from './useSoundPlayer';

// Tocar o som e desenhar o progresso viraram um hook próprio (`useSoundPlayer`),
// compartilhado com o modo direto. Os tipos continuam saindo daqui para quem já
// os importava.
export type { ResolvedSound, SoundPlayback } from './useSoundPlayer';

export interface ChatEntry {
  id: string;
  author: string;
  /**
   * A `identity` de quem mandou — não o nome. É o que liga a mensagem à
   * pessoa de verdade para o clique no chat abrir o controle de volume dela
   * (ver `usePeerVolume`): dois participantes podem escolher o mesmo nome de
   * exibição, mas nunca a mesma `identity`.
   */
  authorIdentity: string;
  body: string;
  sentAt: number;
  isLocal: boolean;
}

export interface RoomMessaging {
  messages: ChatEntry[];
  /** Mensagens chegadas enquanto o chat estava fechado. */
  unread: number;
  sendChat: (body: string) => void;
  playSound: (soundId: string) => void;
  /** Som tocando agora neste cliente, ou null. Um por vez. */
  playing: SoundPlayback | null;
  /** Corta o som na sala inteira, não só aqui. */
  stopSound: (soundId: string) => void;
  markRead: () => void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function newId(): string {
  return crypto.randomUUID();
}

/**
 * Chat e soundboard sobre o canal de dados do LiveKit.
 *
 * O som não trafega como áudio: vai um aviso de algumas dezenas de bytes e
 * cada cliente toca o arquivo que já tem. Mandar o áudio pela sala custaria
 * banda por ouvinte e chegaria fora de sincronia.
 *
 * Nada aqui é persistido: a sala é efêmera, e o histórico morre com ela. Quem
 * entra depois não vê o que passou — é a mesma regra do resto do app.
 */
/**
 * Por onde as mensagens viajam.
 *
 * Existe para o chat e o soundboard funcionarem NOS DOIS modos sem duas
 * cópias da mesma lógica: no LiveKit o canal é o `publishData` do SFU; no
 * modo direto, um `RTCDataChannel` por par. O formato da mensagem é o mesmo
 * — `parseRoomMessage` valida os dois —, e só o cano muda.
 */
export interface MessageTransport {
  /** Publica para a sala inteira. */
  publish: (raw: string) => void;
  /** Assina a chegada; devolve o cancelamento. */
  subscribe: (handler: (raw: string, author: string, authorId: string) => void) => () => void;
  /** Como EU apareço nas mensagens que eu mesmo mando. */
  localName: string;
  localIdentity: string;
}

export function useRoomMessages(
  getVolume: () => number,
  /*
   * De onde sai o arquivo de um id.
   *
   * Entra como parâmetro porque o catálogo deixou de ser uma constante do
   * módulo: além dos sons do build, a sala tem os que a turma enviou, e esses
   * chegam por rede depois da primeira renderização. Ler `SOUNDS` direto aqui
   * faria todo clipe enviado ser ignorado com a mesma mensagem de "não
   * conheço este som".
   */
  resolveSound: (soundId: string) => { file: string } | undefined,
  /**
   * Por onde publicar e receber. Sem isto, usa o canal de dados do LiveKit.
   *
   * É o que faz chat e soundboard existirem nos DOIS modos sem duas cópias da
   * mesma lógica — o formato da mensagem é o mesmo, só o cano muda.
   */
  transport?: MessageTransport,
): RoomMessaging {
  const room = useRoomContext();
  // Por ref: trocar o transporte não pode reassinar o canal e cortar o som
  // que estiver tocando.
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [unread, setUnread] = useState(0);

  // Tocar o som e o estado do progresso vivem no player compartilhado.
  const { playing, play: playLocally, stop: stopLocally } = useSoundPlayer(getVolume, resolveSound);

  const seenRef = useRef(new Set<string>());

  const append = useCallback((entry: ChatEntry, countUnread: boolean) => {
    if (seenRef.current.has(entry.id)) {
      return;
    }
    seenRef.current.add(entry.id);
    setMessages((current) => {
      const next = [...current, entry];
      return next.length > CHAT_HISTORY_LIMIT ? next.slice(-CHAT_HISTORY_LIMIT) : next;
    });
    if (countUnread) {
      setUnread((value) => value + 1);
    }
  }, []);

  useEffect(() => {
    const handleData = (payload: Uint8Array, participant?: RemoteParticipant): void => {
      let raw: unknown;
      try {
        raw = JSON.parse(decoder.decode(payload)) as unknown;
      } catch {
        return;
      }

      const message = parseRoomMessage(raw);
      if (message === null) {
        return;
      }

      if (message.type === 'sound') {
        playLocally(message.soundId);
        return;
      }

      if (message.type === 'sound-stop') {
        stopLocally(message.soundId);
        return;
      }

      const author =
        participant?.name !== undefined && participant.name !== ''
          ? participant.name
          : (participant?.identity ?? 'alguém');

      append(
        {
          id: message.id,
          author,
          authorIdentity: participant?.identity ?? '',
          body: message.body,
          sentAt: message.sentAt,
          isLocal: false,
        },
        true,
      );
    };

    room.on(RoomEvent.DataReceived, handleData);
    return () => {
      room.off(RoomEvent.DataReceived, handleData);
    };
  }, [room, append, playLocally, stopLocally]);

  const publish = useCallback(
    (message: RoomMessage) => {
      const payload = encoder.encode(JSON.stringify(message));
      void room.localParticipant.publishData(payload, { reliable: true }).catch(() => undefined);
    },
    [room],
  );

  const sendChat = useCallback(
    (body: string) => {
      const trimmed = body.trim().slice(0, MAX_CHAT_LENGTH);
      if (trimmed === '') {
        return;
      }
      const message: RoomMessage = {
        type: 'chat',
        id: newId(),
        body: trimmed,
        sentAt: Date.now(),
      };
      publish(message);
      // Aparece na hora para quem escreveu: o canal de dados não devolve o
      // que a própria pessoa publicou.
      const custom = transportRef.current;
      const name = custom?.localName ?? room.localParticipant.name;
      append(
        {
          id: message.id,
          author: name !== undefined && name !== '' ? name : 'você',
          authorIdentity: custom?.localIdentity ?? room.localParticipant.identity,
          body: trimmed,
          sentAt: message.sentAt,
          isLocal: true,
        },
        false,
      );
    },
    [publish, append, room],
  );

  const playSound = useCallback(
    (soundId: string) => {
      publish({ type: 'sound', id: newId(), soundId, sentAt: Date.now() });
      playLocally(soundId);
    },
    [publish, playLocally],
  );

  const stopSound = useCallback(
    (soundId: string) => {
      // Publica antes de parar aqui: quem clicou já sabe o resultado, quem
      // está ouvindo é que precisa do aviso o quanto antes.
      publish({ type: 'sound-stop', id: newId(), soundId, sentAt: Date.now() });
      stopLocally(soundId);
    },
    [publish, stopLocally],
  );

  const markRead = useCallback(() => setUnread(0), []);

  return { messages, unread, sendChat, playSound, playing, stopSound, markRead };
}
