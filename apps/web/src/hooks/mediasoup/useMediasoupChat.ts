import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CHAT_HISTORY_LIMIT,
  MAX_CHAT_LENGTH,
  parseRoomMessage,
  type RoomMessage,
} from '@telecord/shared';
import { msPollBroadcast, msSendBroadcast } from '../../lib/mediasoup';
import { useSoundPlayer, type ResolvedSound, type SoundPlayback } from '../useSoundPlayer';

export type { ResolvedSound, SoundPlayback } from '../useSoundPlayer';

/** Ritmo do polling de chat — mais rápido que o heartbeat de presença (2500ms), porque aqui atraso é percebido como "chat lento". */
const POLL_MS = 1500;

export interface MediasoupChatEntry {
  id: string;
  author: string;
  authorIdentity: string;
  body: string;
  sentAt: number;
  isLocal: boolean;
}

export interface MediasoupChat {
  messages: MediasoupChatEntry[];
  unread: number;
  sendChat: (body: string) => void;
  playSound: (soundId: string) => void;
  playing: SoundPlayback | null;
  stopSound: (soundId: string) => void;
  markRead: () => void;
}

function newId(): string {
  return crypto.randomUUID();
}

/**
 * Chat e soundboard do transporte mediasoup — equivalente a
 * `useRoomMessages`, mas por polling HTTP (`RoomBroadcastMessage`) em vez do
 * canal de dados do LiveKit. Ver o schema da API para o porquê de não ser
 * ainda um DataChannel nativo do mediasoup (SCTP).
 */
export function useMediasoupChat(
  roomId: string,
  peerId: string,
  displayName: string,
  getVolume: () => number,
  resolveSound: (soundId: string) => ResolvedSound | undefined,
): MediasoupChat {
  const [messages, setMessages] = useState<MediasoupChatEntry[]>([]);
  const [unread, setUnread] = useState(0);
  const { playing, play: playLocally, stop: stopLocally } = useSoundPlayer(getVolume, resolveSound);

  const seenRef = useRef(new Set<string>());
  const cursorRef = useRef<string | null>(null);

  const append = useCallback((entry: MediasoupChatEntry, countUnread: boolean) => {
    if (seenRef.current.has(entry.id)) return;
    seenRef.current.add(entry.id);
    setMessages((current) => {
      const next = [...current, entry];
      return next.length > CHAT_HISTORY_LIMIT ? next.slice(-CHAT_HISTORY_LIMIT) : next;
    });
    if (countUnread) setUnread((value) => value + 1);
  }, []);

  // Polling: busca o que chegou desde o último cursor.
  useEffect(() => {
    let vivo = true;
    let timer = 0;

    const poll = async (): Promise<void> => {
      try {
        const { messages: entries, cursor } = await msPollBroadcast(roomId, peerId, cursorRef.current);
        if (!vivo) return;
        cursorRef.current = cursor;

        for (const entry of entries) {
          if (entry.fromPeer === peerId) continue; // eco do que eu mesmo mandei — já apareceu localmente ao enviar.
          let raw: unknown;
          try {
            raw = JSON.parse(entry.body) as unknown;
          } catch {
            continue;
          }
          const message = parseRoomMessage(raw);
          if (message === null) continue;

          if (message.type === 'sound') {
            playLocally(message.soundId);
            continue;
          }
          if (message.type === 'sound-stop') {
            stopLocally(message.soundId);
            continue;
          }
          append(
            {
              id: message.id,
              author: entry.displayName,
              authorIdentity: entry.fromPeer,
              body: message.body,
              sentAt: message.sentAt,
              isLocal: false,
            },
            true,
          );
        }
      } catch {
        // Uma falha de polling não deve travar o loop — tenta de novo no próximo tique.
      } finally {
        if (vivo) timer = window.setTimeout(() => void poll(), POLL_MS);
      }
    };
    void poll();

    return () => {
      vivo = false;
      window.clearTimeout(timer);
    };
  }, [roomId, peerId, append, playLocally, stopLocally]);

  const publish = useCallback(
    (message: RoomMessage) => {
      void msSendBroadcast(roomId, { peerId, displayName, body: JSON.stringify(message) }).catch(() => undefined);
    },
    [roomId, peerId, displayName],
  );

  const sendChat = useCallback(
    (body: string) => {
      const trimmed = body.trim().slice(0, MAX_CHAT_LENGTH);
      if (trimmed === '') return;
      const message: RoomMessage = { type: 'chat', id: newId(), body: trimmed, sentAt: Date.now() };
      publish(message);
      append(
        {
          id: message.id,
          author: displayName !== '' ? displayName : 'você',
          authorIdentity: peerId,
          body: trimmed,
          sentAt: message.sentAt,
          isLocal: true,
        },
        false,
      );
    },
    [publish, append, displayName, peerId],
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
      publish({ type: 'sound-stop', id: newId(), soundId, sentAt: Date.now() });
      stopLocally(soundId);
    },
    [publish, stopLocally],
  );

  const markRead = useCallback(() => setUnread(0), []);

  return { messages, unread, sendChat, playSound, playing, stopSound, markRead };
}
