import { useCallback, useEffect, useRef, useState } from 'react';

/** O mínimo que este player precisa saber de um som para tocá-lo. */
export interface ResolvedSound {
  file: string;
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

export interface SoundPlayer {
  /** Som tocando agora neste cliente, ou null. Um por vez. */
  playing: SoundPlayback | null;
  /** Toca localmente. Sobre um som já tocando, recomeça do início. */
  play: (soundId: string) => void;
  /** Para localmente, se o que estiver tocando ali for este som. */
  stop: (soundId: string) => void;
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
 * Toca os sons do soundboard neste cliente e diz qual está no ar.
 *
 * Vive fora de qualquer transporte de propósito: o áudio não trafega pela sala
 * (SPEC §6.7) — chega um aviso e cada cliente toca o arquivo que já tem. Quem
 * decide QUANDO tocar é o dono do canal (o SFU do LiveKit ou a malha P2P);
 * este hook só cuida do elemento `<audio>`, do "um som por vez" e do estado que
 * alimenta o anel de progresso e o botão de parar. Assim os dois modos
 * compartilham a mesma lógica em vez de manterem duas cópias.
 */
export function useSoundPlayer(
  getVolume: () => number,
  resolveSound: (soundId: string) => ResolvedSound | undefined,
): SoundPlayer {
  const [playing, setPlaying] = useState<SoundPlayback | null>(null);

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
  // Por referência para os callbacks abaixo ficarem estáveis: quem chama passa
  // uma função nova a cada render (o volume e o catálogo mudam), e reconstruir
  // `play`/`stop` reassinaria os canais de dados que dependem deles.
  const getVolumeRef = useRef(getVolume);
  getVolumeRef.current = getVolume;
  const resolveSoundRef = useRef(resolveSound);
  resolveSoundRef.current = resolveSound;

  const play = useCallback((soundId: string) => {
    const sound = resolveSoundRef.current(soundId);
    if (sound === undefined) {
      // Som que este cliente não conhece: catálogo diferente entre versões do
      // app, ou um clipe enviado que a lista daqui ainda não trouxe. Ignorar é
      // melhor do que estourar erro na cara de quem ouve.
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

  const stop = useCallback((soundId: string) => {
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

  /*
   * Encerrar o áudio na saída. Sem dependências: rodar de novo cortaria o som
   * que estiver tocando naquele instante.
   */
  useEffect(() => {
    return () => {
      for (const entry of liveRef.current) {
        hardStop(entry.audio);
      }
      liveRef.current = [];
    };
  }, []);

  return { playing, play, stop };
}
