/**
 * Medidor do microfone: a conta, sem WebAudio, para dar para testar.
 */

/** RMS de uma janela de amostras (−1..1). */
export function rmsOf(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i]!;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Posição da barra, 0..1. Escala comprimida: fala normal ocupa boa parte da
 * barra em vez de ficar espremida embaixo.
 */
export function meterLevel(rms: number): number {
  return Math.min(1, Math.sqrt(Math.max(0, rms)) * 2.4);
}

/** Abaixo disto (≈ −60 dBFS) não entra nada que se ouça. */
export const DEAD_MIC_RMS = 0.001;
/** Tempo sem sinal nenhum até avisar. */
export const DEAD_MIC_MS = 4_000;

/**
 * "Este microfone está mudo ou é o errado?" — o aviso que o Discord mostra.
 *
 * Mudo de verdade dá zero absoluto ou quase (mute no sistema, aparelho
 * errado, permissão do SO negada); ambiente silencioso ainda tem ruído de
 * fundo acima de −60 dBFS. Basta um pico acima do limite para zerar a conta.
 */
export class DeadMicDetector {
  private lastSignalAt: number | null = null;

  constructor(private readonly startedAt: number) {}

  push(rms: number, now: number): void {
    if (rms >= DEAD_MIC_RMS) this.lastSignalAt = now;
  }

  isDead(now: number): boolean {
    return now - (this.lastSignalAt ?? this.startedAt) >= DEAD_MIC_MS;
  }
}
