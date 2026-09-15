import { useCallback, useEffect, useRef, useState } from 'react';
import { CHAT_HISTORY_LIMIT, MAX_CHAT_LENGTH, parseRoomMessage, type RoomMessage } from '@telecord/shared';
import type { MediasoupConnection } from './mediasoupConnection';
import { useSoundPlayer, type ResolvedSound, type SoundPlayback } from '../useSoundPlayer';

export type { ResolvedSound, SoundPlayback } from '../useSoundPlayer';

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
 * Chat e soundboard do transporte mediasoup — ao vivo pelo socket de
 * presença (`MediasoupConnection.sendChat`/`subscribeChat`), sem polling.
 * Substitui o antigo `msPollBroadcast`/`msSendBroadcast` (HTTP a cada
 * 1.5s) — ver `presence.ts` no mediasoup-sfu para o relay.
 *
 * Sem histórico: quem entra na sala não recebe mensagens de antes, mesma
 * regra que já valia com o polling (`pollBroadcast` nunca voltava para trás
 * do cursor de quem perguntava).
 */
export function useMediasoupChat(
  connection: MediasoupConnection | null,
  peerId: string,
  displayName: string,
  getVolume: () => number,
  resolveSound: (soundId: string) => ResolvedSound | undefined,
  /**
   * Chamado quando um som do soundboard toca — local ou de outro
   * participante — com o `peerId` de quem soltou. Ver
   * `useSoundboardSpeakers`.
   */
  onSound?: (identity: string) => void,
): MediasoupChat {
  const [messages, setMessages] = useState<MediasoupChatEntry[]>([]);
  const [unread, setUnread] = useState(0);
  const { playing, play: playLocally, stop: stopLocally } = useSoundPlayer(getVolume, resolveSound);

  const seenRef = useRef(new Set<string>());
  const onSoundRef = useRef(onSound);
  onSoundRef.current = onSound;

  const append = useCallback((entry: MediasoupChatEntry, countUnread: boolean) => {
    if (seenRef.current.has(entry.id)) return;
    seenRef.current.add(entry.id);
    setMessages((current) => {
      const next = [...current, entry];
      return next.length > CHAT_HISTORY_LIMIT ? next.slice(-CHAT_HISTORY_LIMIT) : next;
    });
    if (countUnread) setUnread((value) => value + 1);
  }, []);

  useEffect(() => {
    if (connection === null) return;
    return connection.subscribeChat((fromPeer, authorName, rawBody) => {
      if (fromPeer === peerId) return; // eco do que eu mesmo mandei — já apareceu localmente ao enviar.
      let raw: unknown;
      try {
        raw = JSON.parse(rawBody) as unknown;
      } catch {
        return;
      }
      const message = parseRoomMessage(raw);
      if (message === null) return;

      if (message.type === 'sound') {
        playLocally(message.soundId);
        onSoundRef.current?.(fromPeer);
        return;
      }
      if (message.type === 'sound-stop') {
        stopLocally(message.soundId);
        return;
      }
      append(
        {
          id: message.id,
          author: authorName,
          authorIdentity: fromPeer,
          body: message.body,
          sentAt: message.sentAt,
          isLocal: false,
        },
        true,
      );
    });
  }, [connection, peerId, append, playLocally, stopLocally]);

  const publish = useCallback(
    (message: RoomMessage) => {
      connection?.sendChat(JSON.stringify(message));
    },
    [connection],
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
      onSoundRef.current?.(peerId);
    },
    [publish, playLocally, peerId],
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
