import { useCallback, useState } from 'react';
import {
  readSoundMuted,
  readSoundVolume,
  writeSoundMuted,
  writeSoundVolume,
} from '../lib/storage';

export interface SoundVolume {
  /** 0..1, o que a pessoa escolheu no controle. */
  volume: number;
  muted: boolean;
  /** 0..1 já considerando o mudo — é este que vai para o elemento de áudio. */
  effective: number;
  setVolume: (volume: number) => void;
  toggleMuted: () => void;
}

/**
 * Volume do soundboard.
 *
 * É LOCAL: controla quanto esta pessoa ouve, não o que os outros ouvem. Cada
 * cliente toca o próprio arquivo ao receber o aviso (SPEC §6.7), então não há
 * volume compartilhado para controlar — e é melhor assim, porque ninguém quer
 * que o volume do outro mande no seu.
 *
 * Mudar o volume NÃO desliga o mudo: são estados independentes, e voltar do
 * mudo devolve o volume que estava antes.
 */
export function useSoundVolume(): SoundVolume {
  const [volume, setVolumeState] = useState(() => readSoundVolume());
  const [muted, setMuted] = useState(() => readSoundMuted());

  const setVolume = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(1, next));
    setVolumeState(clamped);
    writeSoundVolume(clamped);
  }, []);

  const toggleMuted = useCallback(() => {
    setMuted((current) => {
      writeSoundMuted(!current);
      return !current;
    });
  }, []);

  return {
    volume,
    muted,
    effective: muted ? 0 : volume,
    setVolume,
    toggleMuted,
  };
}
