import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PeerVolumeEntry, PeerVolumeState } from './usePeerVolume';
import { readPeerMuted, readPeerVolume, writePeerMuted, writePeerVolume } from '../lib/storage';

function clampVolume(value: number): number {
  return Math.max(0, Math.min(2, value));
}

/**
 * Volume individual de cada par no modo direto — 0% a 200%, e mudo à parte.
 *
 * Cumpre o MESMO contrato de `usePeerVolume` (o do modo LiveKit) para os
 * componentes de interface servirem aos dois sem saber em qual modo estão.
 * O que muda é a fonte: lá as tracks vêm do SFU, aqui vêm direto do par.
 *
 * ## Por que WebAudio e não `el.volume`
 *
 * `HTMLMediaElement.volume` é clampado pelo navegador entre 0 e 1, então
 * 200% seria impossível — e 200% é o que salva a pessoa de microfone baixo.
 * Um `GainNode` passa de 1 sem reclamar.
 */
export function useP2PVolume(streams: Map<string, MediaStream>): PeerVolumeState {
  const [entries, setEntries] = useState<Map<string, PeerVolumeEntry>>(new Map());

  const ctxRef = useRef<AudioContext | null>(null);
  const nodes = useRef<Map<string, { gain: GainNode; el: HTMLAudioElement }>>(new Map());

  const ler = useCallback((identity: string): PeerVolumeEntry => {
    return {
      identity,
      volume: readPeerVolume(identity),
      muted: readPeerMuted(identity),
    };
  }, []);

  /*
   * Monta a cadeia de áudio de cada par.
   *
   * O `<audio>` existe e fica MUDO de propósito: alguns navegadores só
   * entregam áudio de um `MediaStream` remoto depois que ele está ligado a um
   * elemento de mídia. Quem toca de verdade é o WebAudio.
   */
  useEffect(() => {
    ctxRef.current ??= new AudioContext();
    const ctx = ctxRef.current;

    for (const [peerId, stream] of streams) {
      if (nodes.current.has(peerId)) continue;
      if (stream.getAudioTracks().length === 0) continue;

      const el = document.createElement('audio');
      el.srcObject = stream;
      el.muted = true;
      el.autoplay = true;
      void el.play().catch(() => undefined);

      const source = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      const atual = ler(peerId);
      gain.gain.value = atual.muted ? 0 : atual.volume;
      source.connect(gain).connect(ctx.destination);

      nodes.current.set(peerId, { gain, el });
    }

    // Quem saiu leva a cadeia junto: GainNode pendurado continua consumindo.
    for (const [peerId, node] of nodes.current) {
      if (!streams.has(peerId)) {
        node.gain.disconnect();
        node.el.srcObject = null;
        nodes.current.delete(peerId);
      }
    }
  }, [streams, ler]);

  useEffect(() => {
    const atuais = nodes.current;
    return () => {
      for (const node of atuais.values()) {
        node.gain.disconnect();
        node.el.srcObject = null;
      }
      atuais.clear();
      void ctxRef.current?.close();
    };
  }, []);

  const aplicar = useCallback((identity: string, entry: PeerVolumeEntry) => {
    const node = nodes.current.get(identity);
    if (node !== undefined) {
      node.gain.gain.value = entry.muted ? 0 : entry.volume;
    }
    setEntries((atual) => new Map(atual).set(identity, entry));
  }, []);

  const setVolume = useCallback(
    (identity: string, volume: number) => {
      const valor = clampVolume(volume);
      writePeerVolume(identity, valor);
      aplicar(identity, { identity, volume: valor, muted: readPeerMuted(identity) });
    },
    [aplicar],
  );

  const toggleMuted = useCallback(
    (identity: string) => {
      const proximo = !readPeerMuted(identity);
      writePeerMuted(identity, proximo);
      aplicar(identity, { identity, volume: readPeerVolume(identity), muted: proximo });
    },
    [aplicar],
  );

  const get = useCallback(
    (identity: string): PeerVolumeEntry => entries.get(identity) ?? ler(identity),
    [entries, ler],
  );

  return useMemo(
    () => ({ entries, get, setVolume, toggleMuted }),
    [entries, get, setVolume, toggleMuted],
  );
}
