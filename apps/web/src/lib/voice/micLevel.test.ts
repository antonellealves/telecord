import { describe, expect, it } from 'vitest';
import { DEAD_MIC_MS, DeadMicDetector, meterLevel, rmsOf } from './micLevel';

describe('rmsOf / meterLevel', () => {
  it('silêncio digital é zero', () => {
    expect(rmsOf(new Float32Array(1024))).toBe(0);
    expect(meterLevel(0)).toBe(0);
  });

  it('onda quadrada de amplitude 0,5 tem RMS 0,5 e enche a barra', () => {
    const samples = Float32Array.from({ length: 1024 }, (_, i) => (i % 2 === 0 ? 0.5 : -0.5));
    expect(rmsOf(samples)).toBeCloseTo(0.5);
    expect(meterLevel(0.5)).toBe(1);
  });

  it('fala normal (~−26 dBFS) fica no meio da barra', () => {
    expect(meterLevel(0.05)).toBeGreaterThan(0.4);
    expect(meterLevel(0.05)).toBeLessThan(0.7);
  });
});

describe('DeadMicDetector', () => {
  it('avisa depois de alguns segundos sem sinal nenhum', () => {
    const detector = new DeadMicDetector(0);
    for (let t = 0; t <= DEAD_MIC_MS; t += 100) detector.push(0, t);
    expect(detector.isDead(DEAD_MIC_MS - 1)).toBe(false);
    expect(detector.isDead(DEAD_MIC_MS)).toBe(true);
  });

  it('ruído de fundo de uma sala quieta não conta como mudo', () => {
    const detector = new DeadMicDetector(0);
    for (let t = 0; t <= 10_000; t += 100) detector.push(0.003, t);
    expect(detector.isDead(10_000)).toBe(false);
  });

  it('um pico zera a contagem', () => {
    const detector = new DeadMicDetector(0);
    detector.push(0.2, 3_000);
    expect(detector.isDead(6_000)).toBe(false);
    expect(detector.isDead(3_000 + DEAD_MIC_MS)).toBe(true);
  });
});
