import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { type RemoteParticipant, RoomEvent } from 'livekit-client';
import {
  CHAT_HISTORY_LIMIT,
  MAX_CHAT_LENGTH,
  parseRoomMessage,
  type RoomMessage,
} from '@telecord/shared';
import { findSound } from '../lib/sounds';

export interface ChatEntry {
  id: string;
  author: string;
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
export function useRoomMessages(getVolume: () => number): RoomMessaging {
  const room = useRoomContext();
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [unread, setUnread] = useState(0);

  const seenRef = useRef(new Set<string>());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const getVolumeRef = useRef(getVolume);
  getVolumeRef.current = getVolume;

  const playLocally = useCallback((soundId: string) => {
    const sound = findSound(soundId);
    if (sound === undefined) {
      // Som que este cliente não conhece: pode ser catálogo diferente entre
      // versões. Ignorar é melhor do que estourar erro na cara de quem ouve.
      return;
    }
    const volume = getVolumeRef.current();
    if (volume <= 0) {
      // Mudo ou volume zerado: nem cria o elemento. O aviso continua chegando
      // e sendo aceito — quem silenciou foi só este cliente.
      return;
    }

    audioRef.current?.pause();
    const audio = new Audio(sound.file);
    audio.volume = Math.min(1, volume);
    audioRef.current = audio;
    void audio.play().catch(() => undefined);
  }, []);

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

      const author =
        participant?.name !== undefined && participant.name !== ''
          ? participant.name
          : (participant?.identity ?? 'alguém');

      append(
        { id: message.id, author, body: message.body, sentAt: message.sentAt, isLocal: false },
        true,
      );
    };

    room.on(RoomEvent.DataReceived, handleData);
    return () => {
      room.off(RoomEvent.DataReceived, handleData);
      audioRef.current?.pause();
    };
  }, [room, append, playLocally]);

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
      const name = room.localParticipant.name;
      append(
        {
          id: message.id,
          author: name !== undefined && name !== '' ? name : 'você',
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

  const markRead = useCallback(() => setUnread(0), []);

  return { messages, unread, sendChat, playSound, markRead };
}
