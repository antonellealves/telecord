import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readPeerMuted, readPeerVolume, writePeerMuted, writePeerVolume } from '../../lib/storage';
import type { RemoteTrackHandle } from './mediasoupConnection';
import type { MediasoupEngine } from './useMediasoupEngine';

export interface MediasoupPeerVolumeEntry {
  identity: string;
  volume: number;
  muted: boolean;
}

export interface MediasoupPeerVolumeState {
  entries: Map<string, MediasoupPeerVolumeEntry>;
  get: (identity: string) => MediasoupPeerVolumeEntry;
  setVolume: (identity: string, volume: number) => void;
  toggleMuted: (identity: string) => void;
  /**
   * A política de autoplay do navegador suspende um `AudioContext` criado
   * sem gesto do usuário — sem isto, o sintoma é "entrei e não escuto
   * ninguém" sem erro nenhum, mesmo equivalente ao `useAudioPlaybackBlocked`
   * do LiveKit (que não pode ser reaproveitado aqui: ele lê de `Room`, que
   * não existe neste transporte).
   */
  audioBlocked: boolean;
  unblockAudio: () => void;
}

function clampVolume(value: number): number {
  return Math.max(0, Math.min(2, value));
}

function isAudioTrack(track: RemoteTrackHandle): boolean {
  return track.trackKind === 'mic' || track.trackKind === 'screen-audio';
}

/**
 * Volume individual de cada participante remoto, no transporte mediasoup —
 * equivalente a `usePeerVolume`.
 *
 * ## Por que é uma implementação PRÓPRIA, e não a reaproveitada do LiveKit
 *
 * `usePeerVolume` faz `publication.track instanceof RemoteAudioTrack` para
 * decidir quando rotear por WebAudio — uma classe concreta do livekit-client
 * que não existe (e não tem como ser satisfeita por um objeto parecido) fora
 * de uma conexão LiveKit de verdade. Aqui o roteamento é construído direto
 * sobre `MediaStreamTrack` cru: cada track de áudio remota vira um
 * `MediaStreamAudioSourceNode` → `GainNode` → destino, e o ganho aceita
 * qualquer valor positivo — mesma vantagem sobre `HTMLMediaElement.volume`
 * (clampado em 1) que motivou o WebAudio no lado do LiveKit.
 */
export function useMediasoupPeerVolume(engine: MediasoupEngine): MediasoupPeerVolumeState {
  const [audioBlocked, setAudioBlocked] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nodesByConsumerRef = useRef<
    Map<string, { source: MediaStreamAudioSourceNode; gain: GainNode; anchor: HTMLAudioElement }>
  >(new Map());
  const [entries, setEntries] = useState<Map<string, MediasoupPeerVolumeEntry>>(() => new Map());
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const audioContext = useCallback((): AudioContext | null => {
    if (audioContextRef.current !== null) return audioContextRef.current;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) return null;
    /*
     * 48 kHz explícito, igual à taxa do Opus e da captura.
     *
     * Sem isto o `AudioContext` nasce na taxa do DISPOSITIVO DE SAÍDA — que
     * em muita placa é 44.1 kHz. Aí todo o áudio de 48 kHz que vem da sala é
     * reamostrado em tempo real para 44.1, e reamostragem em tempo real é
     * feita com filtro barato: introduz aliasing e come justamente a banda
     * alta que este perfil todo existe para preservar.
     *
     * `latencyHint: 'playback'` dá ao navegador um buffer maior, que troca
     * alguns milissegundos de atraso por estabilidade — sem isto, buffer
     * curto demais gera micro-cortes (underrun) que soam como estalo. Numa
     * conversa, alguns ms a mais não são perceptíveis; estalo é.
     */
    const context = new Ctor({ sampleRate: 48_000, latencyHint: 'playback' });
    audioContextRef.current = context;
    return context;
  }, []);

  const applyGain = useCallback(
    (consumerId: string, entry: MediasoupPeerVolumeEntry) => {
      const nodes = nodesByConsumerRef.current.get(consumerId);
      if (nodes === undefined) return;
      nodes.gain.gain.value = entry.muted ? 0 : entry.volume;
    },
    [],
  );

  // Cria (ou remove) o roteamento WebAudio a cada track de áudio remota que aparece/some.
  useEffect(() => {
    const context = audioContext();
    if (context === null) return;
    // Tenta retomar sozinho antes de acusar bloqueio: se a pessoa já clicou
    // em qualquer lugar da página (entrar na sala, ligar o mic), o navegador
    // permite o `resume()` sem gesto novo, e o aviso de "ative o áudio" nem
    // precisa aparecer. Só quando o `resume()` falha é que o gate é mostrado.
    if (context.state !== 'running') {
      void context
        .resume()
        .then(() => setAudioBlocked(context.state !== 'running'))
        .catch(() => setAudioBlocked(true));
    } else {
      setAudioBlocked(false);
    }

    const audioTracks = engine.remoteTracks.filter(isAudioTrack);
    const liveConsumerIds = new Set(audioTracks.map((track) => track.consumerId));

    for (const track of audioTracks) {
      if (nodesByConsumerRef.current.has(track.consumerId)) continue;
      const stream = new MediaStream([track.track]);

      /*
       * O `<audio>` ÂNCORA é obrigatório, mesmo mudo e fora da tela.
       *
       * No Chrome, uma track de áudio vinda de `RTCPeerConnection` só começa
       * a entregar amostras de verdade quando a MediaStream tem um
       * HTMLMediaElement consumindo ela. Só `createMediaStreamSource()` não
       * basta: o `MediaStreamAudioSourceNode` fica ligado a uma fonte que
       * nunca produz nada, e o resultado é silêncio ABSOLUTO — sem erro
       * nenhum, com os pacotes RTP chegando normalmente (bytesReceived
       * subindo) e `audioLevel` cravado em zero. Era exatamente este o
       * sintoma: vídeo funcionava (o `<video>` de `ScreenStage`/`CameraStrip`
       * já é o elemento âncora dele), voz não.
       *
       * `muted` é o que evita ouvir tudo DUAS vezes: quem reproduz de fato é
       * a cadeia WebAudio abaixo (que permite ganho > 1, ao contrário de
       * `HTMLMediaElement.volume`); este elemento existe só para destravar o
       * pipeline.
       */
      const anchor = new Audio();
      anchor.srcObject = stream;
      anchor.muted = true;
      anchor.autoplay = true;
      void anchor.play().catch(() => undefined);

      const source = context.createMediaStreamSource(stream);
      const gain = context.createGain();
      source.connect(gain);
      gain.connect(context.destination);
      nodesByConsumerRef.current.set(track.consumerId, { source, gain, anchor });

      const stored = readPeerVolume(track.ownerPeerId);
      const mutedStored = readPeerMuted(track.ownerPeerId);
      setEntries((current) => {
        const existing = current.get(track.ownerPeerId);
        if (existing !== undefined && existing.volume === stored && existing.muted === mutedStored) {
          return current;
        }
        const next = new Map(current);
        next.set(track.ownerPeerId, { identity: track.ownerPeerId, volume: stored, muted: mutedStored });
        return next;
      });
      gain.gain.value = mutedStored ? 0 : stored;
    }

    for (const [consumerId, nodes] of nodesByConsumerRef.current) {
      if (liveConsumerIds.has(consumerId)) continue;
      nodes.source.disconnect();
      nodes.gain.disconnect();
      nodes.anchor.pause();
      nodes.anchor.srcObject = null;
      nodesByConsumerRef.current.delete(consumerId);
    }
  }, [engine.remoteTracks, audioContext]);

  // Fecha o AudioContext ao sair da sala.
  useEffect(() => {
    return () => {
      for (const nodes of nodesByConsumerRef.current.values()) {
        nodes.source.disconnect();
        nodes.gain.disconnect();
        nodes.anchor.pause();
        nodes.anchor.srcObject = null;
      }
      nodesByConsumerRef.current.clear();
      void audioContextRef.current?.close();
      audioContextRef.current = null;
    };
  }, []);

  const setVolume = useCallback((identity: string, volume: number) => {
    const clamped = clampVolume(volume);
    writePeerVolume(identity, clamped);
    setEntries((current) => {
      const next = new Map(current);
      const existing = next.get(identity);
      next.set(identity, { identity, volume: clamped, muted: existing?.muted ?? false });
      return next;
    });
  }, []);

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

  // Reaplica o ganho sempre que o mapa muda.
  useEffect(() => {
    for (const track of engine.remoteTracks.filter(isAudioTrack)) {
      const entry = entriesRef.current.get(track.ownerPeerId);
      if (entry !== undefined) applyGain(track.consumerId, entry);
    }
  }, [entries, engine.remoteTracks, applyGain]);

  const get = useCallback(
    (identity: string): MediasoupPeerVolumeEntry =>
      entries.get(identity) ?? { identity, volume: 1, muted: false },
    [entries],
  );

  const unblockAudio = useCallback(() => {
    const context = audioContextRef.current;
    if (context === null) return;
    void context.resume().then(() => setAudioBlocked(context.state !== 'running'));
  }, []);

  return useMemo(
    () => ({ entries, get, setVolume, toggleMuted, audioBlocked, unblockAudio }),
    [entries, get, setVolume, toggleMuted, audioBlocked, unblockAudio],
  );
}
