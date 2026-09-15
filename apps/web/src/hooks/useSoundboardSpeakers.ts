import { useCallback, useRef, useState } from 'react';

/** Quanto tempo o microfone de quem soltou o som fica "aceso" sem confirmação de fim. */
const FALLBACK_MS = 2500;

export interface SoundboardSpeakers {
  /** Identities marcadas como "falando" por terem disparado um som agora. */
  speaking: Set<string>;
  /** Acende `identity`, por `durationMs` (ou o padrão, se omitido/desconhecido). */
  mark: (identity: string, durationMs?: number | null) => void;
}

/**
 * Acende, no box de participantes, quem soltou um som do soundboard — mesmo
 * destaque visual de "está falando", mas disparado pelo áudio local de cada
 * cliente (SPEC §6.7: o som não trafega pela sala, só o aviso). Não substitui
 * a detecção de fala de verdade (LiveKit: nível de áudio no servidor;
 * mediasoup: `useSpeakingDetector`) — soma a ela.
 *
 * Vive fora de qualquer transporte, como `useSoundPlayer`: quem chama (o chat
 * do LiveKit ou o do mediasoup) só precisa avisar QUEM tocou o som.
 */
export function useSoundboardSpeakers(): SoundboardSpeakers {
  const [speaking, setSpeaking] = useState<Set<string>>(new Set());
  const timersRef = useRef(new Map<string, number>());

  const mark = useCallback((identity: string, durationMs?: number | null) => {
    const existing = timersRef.current.get(identity);
    if (existing !== undefined) {
      window.clearTimeout(existing);
    }

    setSpeaking((current) => {
      if (current.has(identity)) return current;
      const next = new Set(current);
      next.add(identity);
      return next;
    });

    const ms =
      durationMs !== null && durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0
        ? durationMs
        : FALLBACK_MS;

    const timer = window.setTimeout(() => {
      timersRef.current.delete(identity);
      setSpeaking((current) => {
        if (!current.has(identity)) return current;
        const next = new Set(current);
        next.delete(identity);
        return next;
      });
    }, ms);
    timersRef.current.set(identity, timer);
  }, []);

  return { speaking, mark };
}
