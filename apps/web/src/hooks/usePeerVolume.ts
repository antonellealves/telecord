import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import {
  RemoteAudioTrack,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import { readPeerMuted, readPeerVolume, writePeerMuted, writePeerVolume } from '../lib/storage';

/** Fontes de áudio remoto que um participante pode publicar. */
const AUDIO_SOURCES: Track.Source[] = [Track.Source.Microphone, Track.Source.ScreenShareAudio];

export interface PeerVolumeEntry {
  identity: string;
  /** 0..2 (0% a 200%). É o que o slider mostra, mudo ou não. */
  volume: number;
  muted: boolean;
}

export interface PeerVolumeState {
  /** Estado por `identity`. Quem nunca foi ajustado nem aparece aqui — vale 100%. */
  entries: Map<string, PeerVolumeEntry>;
  get: (identity: string) => PeerVolumeEntry;
  setVolume: (identity: string, volume: number) => void;
  toggleMuted: (identity: string) => void;
}

function clampVolume(value: number): number {
  return Math.max(0, Math.min(2, value));
}

/**
 * Volume individual de cada participante remoto — 0% a 200%, e mudo à parte.
 *
 * ## Por que precisa de WebAudio, e não só `el.volume`
 *
 * `HTMLMediaElement.volume` é clampado pelo próprio navegador entre 0 e 1: um
 * valor de 2 (o "enhancement" de 200%) é silenciosamente cortado para 1, sem
 * erro — o slider mentiria. `GainNode.gain`, do WebAudio, aceita qualquer
 * ganho positivo; é o único caminho que faz o boost valer de verdade.
 *
 * `RoomAudioRenderer` (do `@livekit/components-react`) NÃO usa WebAudio — ele
 * só define `el.volume`. Por isso o ajuste aqui não passa por `setVolume` do
 * SDK: chama `track.setAudioContext()` diretamente, que é o gancho que o
 * próprio LiveKit expõe para rotear o elemento por um `GainNode` (ver
 * `RemoteAudioTrack.connectWebAudio` na SDK). Um `AudioContext` só, guardado
 * em ref e compartilhado por todo mundo — abrir um por participante gastaria
 * um `MediaStreamAudioSourceNode` a mais por pessoa à toa.
 *
 * ## Por que é por `identity`, e reaplicado a cada evento de track
 *
 * A publicação de áudio pode cair e voltar — alguém remuta o microfone, a
 * conexão cai e reconecta, entra depois de já ter sido ajustado noutra sala.
 * `TrackSubscribed` e `LocalTrackPublished`-equivalente do remoto cobrem os
 * casos; reaplicar o mapa inteiro a cada evento, e não só ao publicar,
 * garante que ninguém perde o ajuste no meio da sessão.
 *
 * ## O que fica de fora, de propósito
 *
 * Isto NUNCA é enviado a mais ninguém: é preferência de quem ouve, não do
 * outro lado. Guardado em `localStorage`, mesma regra do volume do
 * soundboard.
 */
export function usePeerVolume(): PeerVolumeState {
  const room = useRoomContext();
  const audioContextRef = useRef<AudioContext | null>(null);
  const [entries, setEntries] = useState<Map<string, PeerVolumeEntry>>(() => new Map());
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const audioContext = useCallback((): AudioContext | null => {
    if (audioContextRef.current !== null) {
      return audioContextRef.current;
    }
    // `AudioContext` pode não existir (SSR não é o caso aqui, mas navegador
    // antigo ou modo restrito, sim) — sem ele o ajuste vira sem efeito, não
    // erro: a pessoa continua ouvindo no volume padrão.
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) {
      return null;
    }
    const context = new Ctor();
    audioContextRef.current = context;
    return context;
  }, []);

  /** Aplica volume+mudo numa `RemoteAudioTrack`, criando o roteamento WebAudio se preciso. */
  const applyToTrack = useCallback(
    (track: RemoteAudioTrack, entry: PeerVolumeEntry): void => {
      const context = audioContext();
      if (context === null) {
        return;
      }
      // Sem isto o primeiro ajuste de alguém acontece antes do elemento
      // existir, e `connectWebAudio` (chamado dentro de `setAudioContext`)
      // não teria o que conectar — ele só age se já houver elemento anexado,
      // e o `RoomAudioRenderer` é quem cria esse elemento.
      track.setAudioContext(context);
      track.setVolume(entry.muted ? 0 : entry.volume);
    },
    [audioContext],
  );

  /** Passa o mapa inteiro nas tracks de áudio ATUALMENTE publicadas. */
  const reapplyAll = useCallback(() => {
    for (const participant of room.remoteParticipants.values()) {
      const entry = entriesRef.current.get(participant.identity);
      if (entry === undefined) {
        continue;
      }
      for (const source of AUDIO_SOURCES) {
        const publication = participant.getTrackPublication(source);
        if (publication?.track instanceof RemoteAudioTrack) {
          applyToTrack(publication.track, entry);
        }
      }
    }
  }, [room, applyToTrack]);

  // Carrega do storage quem já foi ajustado antes, na entrada na sala — e
  // aplica assim que a track existir (o efeito abaixo cuida disso).
  useEffect(() => {
    const seed = new Map<string, PeerVolumeEntry>();
    for (const participant of room.remoteParticipants.values()) {
      const identity = participant.identity;
      const volume = readPeerVolume(identity);
      const muted = readPeerMuted(identity);
      if (volume !== 1 || muted) {
        seed.set(identity, { identity, volume, muted });
      }
    }
    setEntries(seed);
    // Roda só na entrada: participantes que chegam DEPOIS ganham o valor
    // salvo deles no handler de `TrackSubscribed`, não aqui.
  }, [room]);

  // Reaplica sempre que uma track de áudio remota (re)aparece. É o que cobre
  // reconexão, remutar o microfone e quem entra depois de já ter um ajuste
  // salvo de uma sessão anterior nesta mesma sala.
  useEffect(() => {
    const handleSubscribed = (
      _track: RemoteTrack,
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ): void => {
      if (!AUDIO_SOURCES.includes(publication.source)) {
        return;
      }
      const stored = readPeerVolume(participant.identity);
      const mutedStored = readPeerMuted(participant.identity);
      // Sincroniza o mapa em memória com o que está no storage: garante que o
      // slider mostre o valor certo mesmo que esta seja a PRIMEIRA vez que a
      // track desta pessoa aparece nesta execução do hook.
      setEntries((current) => {
        const existing = current.get(participant.identity);
        if (existing !== undefined && existing.volume === stored && existing.muted === mutedStored) {
          return current;
        }
        const next = new Map(current);
        next.set(participant.identity, { identity: participant.identity, volume: stored, muted: mutedStored });
        return next;
      });
      reapplyAll();
    };

    room.on(RoomEvent.TrackSubscribed, handleSubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, handleSubscribed);
    };
  }, [room, reapplyAll]);

  // O contexto de áudio nasce suspenso até um gesto do usuário (mesma
  // política de autoplay que o `AudioPlaybackGate` já trata para o áudio
  // normal). `startAudio()` do Room já pede esse gesto; aqui só garantimos
  // que o NOSSO contexto acompanha esse desbloqueio.
  useEffect(() => {
    const handle = (): void => {
      const context = audioContextRef.current;
      if (context !== null && context.state !== 'running') {
        void context.resume();
      }
    };
    room.on(RoomEvent.AudioPlaybackStatusChanged, handle);
    return () => {
      room.off(RoomEvent.AudioPlaybackStatusChanged, handle);
    };
  }, [room]);

  // Fecha o AudioContext ao sair da sala — ele não fecha sozinho e ficaria
  // consumindo um dispositivo de áudio do sistema pendurado.
  useEffect(() => {
    return () => {
      void audioContextRef.current?.close();
      audioContextRef.current = null;
    };
  }, []);

  const setVolume = useCallback(
    (identity: string, volume: number) => {
      const clamped = clampVolume(volume);
      writePeerVolume(identity, clamped);
      setEntries((current) => {
        const next = new Map(current);
        const existing = next.get(identity);
        next.set(identity, { identity, volume: clamped, muted: existing?.muted ?? false });
        return next;
      });
    },
    [],
  );

  const toggleMuted = useCallback((identity: string) => {
    setEntries((current) => {
      const existing = current.get(identity);
      const muted = !(existing?.muted ?? false);
      writePeerMuted(identity, muted);
      const next = new Map(current);
      next.set(identity, { identity, volume: existing?.volume ?? 1, muted });
      return next;
    });
  }, []);

  // Reaplica sempre que o mapa muda — é o efeito visível de mexer no slider.
  useEffect(() => {
    reapplyAll();
  }, [entries, reapplyAll]);

  const get = useCallback(
    (identity: string): PeerVolumeEntry => entries.get(identity) ?? { identity, volume: 1, muted: false },
    [entries],
  );

  return useMemo(() => ({ entries, get, setVolume, toggleMuted }), [entries, get, setVolume, toggleMuted]);
}
