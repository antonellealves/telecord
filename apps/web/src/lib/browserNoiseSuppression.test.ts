import type { AudioCaptureOptions } from 'livekit-client';
import { describe, expect, it } from 'vitest';
import { applyBrowserNoiseSuppression, type CaptureTrack } from './browserNoiseSuppression';

type Browser = 'chrome' | 'firefox' | 'calado';

/**
 * Um microfone de mentira com o comportamento de cada navegador:
 * - `chrome`: `applyConstraints` resolve e NÃO muda o filtro; só reabrir muda.
 * - `firefox`: `applyConstraints` muda na hora.
 * - `calado`: não informa o estado do filtro em `getSettings`.
 */
function fakeTrack(browser: Browser, noiseSuppression: boolean) {
  const calls: string[] = [];
  let current = noiseSuppression;
  let restartedWith: AudioCaptureOptions | undefined;
  const track: CaptureTrack = {
    mediaStreamTrack: {
      getSettings: () => (browser === 'calado' ? {} : { noiseSuppression: current }),
    },
    constraints: { deviceId: { exact: 'microfone-usb' }, echoCancellation: true, channelCount: 1, sampleRate: 48_000 },
    applyConstraints: async (constraints) => {
      calls.push('apply');
      if (browser === 'firefox') current = constraints.noiseSuppression === true;
    },
    restartTrack: async (options) => {
      calls.push('restart');
      restartedWith = options;
      current = options?.noiseSuppression === true;
    },
  };
  return { track, calls, restartedWith: () => restartedWith, current: () => current };
}

describe('applyBrowserNoiseSuppression', () => {
  it('não toca no microfone que já está como pedido', async () => {
    const fake = fakeTrack('chrome', false);
    await applyBrowserNoiseSuppression(fake.track, false);
    expect(fake.calls).toEqual([]);
  });

  it('reabre o microfone quando o navegador aceita a troca e não aplica (Chrome)', async () => {
    const fake = fakeTrack('chrome', true);
    await applyBrowserNoiseSuppression(fake.track, false);
    expect(fake.calls).toEqual(['apply', 'restart']);
    expect(fake.current()).toBe(false);
  });

  it('reabre no MESMO aparelho, com o resto da captura intacto', async () => {
    const fake = fakeTrack('chrome', false);
    await applyBrowserNoiseSuppression(fake.track, true);
    expect(fake.restartedWith()).toEqual({
      deviceId: { exact: 'microfone-usb' },
      echoCancellation: true,
      channelCount: 1,
      sampleRate: 48_000,
      noiseSuppression: true,
      voiceIsolation: true,
    });
  });

  it('não reabre quando applyConstraints resolve de verdade (Firefox)', async () => {
    const fake = fakeTrack('firefox', true);
    await applyBrowserNoiseSuppression(fake.track, false);
    expect(fake.calls).toEqual(['apply']);
    expect(fake.current()).toBe(false);
  });

  it('reabre quando applyConstraints é recusado', async () => {
    const fake = fakeTrack('chrome', true);
    fake.track.applyConstraints = async () => {
      fake.calls.push('apply');
      throw new DOMException('não suportado', 'OverconstrainedError');
    };
    await applyBrowserNoiseSuppression(fake.track, false);
    expect(fake.calls).toEqual(['apply', 'restart']);
  });

  it('sem como conferir o estado, não reabre o microfone às cegas', async () => {
    const fake = fakeTrack('calado', true);
    await applyBrowserNoiseSuppression(fake.track, false);
    expect(fake.calls).toEqual(['apply']);
  });
});
