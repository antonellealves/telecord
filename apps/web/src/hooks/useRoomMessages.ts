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

/** O som que este cliente está tocando agora. */
export interface SoundPlayback {
  soundId: string;
  /**
   * Sobe a cada disparo. É o que reinicia a barra de progresso quando o mesmo
   * som é disparado por cima de si mesmo — sem isso o React reaproveitaria o
   * nó e a animação continuaria de onde estava.
   */
  token: number;
  /**
   * Duração em segundos, conhecida só quando a reprodução começa de fato.
   * Fica `null` se o navegador não souber dizer (arquivo sem cabeçalho
   * decente), e aí não há progresso para desenhar.
   */
  duration: number | null;
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
 * Encerra o elemento, em vez de só pausar.
 *
 * `pause()` sozinho deixa o elemento vivo, e uma chamada de `play()` ainda
 * pendente pode retomar depois dele — o que chega a quem clicou como "apertei
 * parar e o som continuou". Soltar a fonte e recarregar cancela qualquer
 * carregamento ou reprodução em curso, sem depender de ordem.
 */
function hardStop(audio: HTMLAudioElement): void {
  audio.pause();
  try {
    audio.currentTime = 0;
  } catch {
    // Alguns navegadores recusam a escrita antes de haver mídia carregada.
  }
  audio.removeAttribute('src');
  audio.load();
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
  const [playing, setPlaying] = useState<SoundPlayback | null>(null);

  const seenRef = useRef(new Set<string>());
  /*
   * Todo áudio do soundboard vivo neste cliente.
   *
   * É uma lista, não uma referência única, porque parar precisa alcançar
   * qualquer elemento daquele som. Com uma referência só, um áudio que
   * escapasse de uma corrida entre dois avisos ficaria tocando sem nada
   * apontando para ele — e nenhum clique em parar o alcançaria mais.
   */
  const liveRef = useRef<{ soundId: string; audio: HTMLAudioElement }[]>([]);
  // Espelho do que está tocando: os eventos do <audio> disparam fora do ciclo
  // do React e precisam decidir sem depender do que já foi renderizado.
  const playingRef = useRef<string | null>(null);
  const tokenRef = useRef(0);
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

    // Um som por vez: o novo encerra o que estava tocando.
    for (const entry of liveRef.current) {
      hardStop(entry.audio);
    }
    liveRef.current = [];

    const audio = new Audio(sound.file);
    audio.volume = Math.min(1, volume);
    liveRef.current = [{ soundId, audio }];
    playingRef.current = soundId;
    tokenRef.current += 1;
    const token = tokenRef.current;
    setPlaying({ soundId, token, duration: null });

    /*
     * A duração só entra no estado quando o som começa a sair de fato. Entrar
     * antes, no `loadedmetadata`, adiantaria a barra em relação ao áudio pelo
     * tempo que o navegador levasse para soltar o primeiro sample.
     */
    audio.addEventListener(
      'playing',
      () => {
        const seconds = audio.duration;
        if (!Number.isFinite(seconds) || seconds <= 0) {
          return;
        }
        setPlaying((current) =>
          current !== null && current.token === token ? { ...current, duration: seconds } : current,
        );
      },
      { once: true },
    );

    const forget = (): void => {
      liveRef.current = liveRef.current.filter((entry) => entry.audio !== audio);
      // Só apaga o estado se ninguém tiver assumido o lugar desde então: um som
      // disparado por cima do outro faria o `ended` do antigo apagar o novo.
      if (playingRef.current === soundId && liveRef.current.length === 0) {
        playingRef.current = null;
        setPlaying(null);
      }
    };
    audio.addEventListener('ended', forget, { once: true });
    audio.addEventListener('error', forget, { once: true });
    void audio.play().catch(forget);
  }, []);

  const stopLocally = useCallback((soundId: string) => {
    // Encerra qualquer elemento daquele som, não só o registrado como corrente:
    // se sobrou algum de uma corrida, é justamente ele que a pessoa continua
    // ouvindo depois de apertar parar.
    const restantes: { soundId: string; audio: HTMLAudioElement }[] = [];
    let encerrou = false;
    for (const entry of liveRef.current) {
      if (entry.soundId === soundId) {
        hardStop(entry.audio);
        encerrou = true;
      } else {
        restantes.push(entry);
      }
    }
    liveRef.current = restantes;

    if (!encerrou) {
      // Pedido atrasado, para um som que já terminou ou já foi substituído:
      // não pode derrubar o que está tocando agora.
      return;
    }
    if (playingRef.current === soundId) {
      playingRef.current = null;
      setPlaying(null);
    }
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

      if (message.type === 'sound-stop') {
        stopLocally(message.soundId);
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
    };
  }, [room, append, playLocally, stopLocally]);

  /*
   * Encerrar o áudio vive num efeito próprio, sem dependências: junto com o
   * efeito do canal de dados, cada reassinatura dele cortaria o som que estiver
   * tocando. Aqui só roda na saída da sala.
   */
  useEffect(() => {
    return () => {
      for (const entry of liveRef.current) {
        hardStop(entry.audio);
      }
      liveRef.current = [];
    };
  }, []);

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
