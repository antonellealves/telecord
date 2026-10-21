import type { AudioCaptureOptions } from 'livekit-client';
import { describe, expect, it } from 'vitest';
import { applyCaptureProcessing, type CaptureProcessing, type CaptureTrack } from './captureProcessing';
import { constraintBoolean } from './voice/voiceProfile';

type Browser = 'chrome' | 'firefox' | 'calado';

const ON: CaptureProcessing = { noiseSuppression: true, echoCancellation: true };
const RAW_WITH_ECHO: CaptureProcessing = { noiseSuppression: false, echoCancellation: true };
const RAW: CaptureProcessing = { noiseSuppression: false, echoCancellation: false };

/**
 * Um microfone de mentira com o comportamento de cada navegador:
 * - `chrome`: `applyConstraints` resolve e NÃO muda nada; só reabrir muda.
 * - `firefox`: `applyConstraints` muda na hora.
 * - `calado`: não informa o estado em `getSettings`.
 */
function fakeTrack(browser: Browser, initial: CaptureProcessing) {
  const calls: string[] = [];
  let current = { ...initial };
  let restartedWith: AudioCaptureOptions | undefined;
  const adopt = (options: AudioCaptureOptions | undefined): void => {
    current = {
      noiseSuppression: constraintBoolean(options?.noiseSuppression) === true,
      echoCancellation: constraintBoolean(options?.echoCancellation) === true,
    };
  };
  const track: CaptureTrack = {
    mediaStreamTrack: {
      getSettings: () => (browser === 'calado' ? {} : { ...current }),
    },
    constraints: { deviceId: { exact: 'microfone-usb' }, echoCancellation: { ideal: true }, autoGainControl: { ideal: true } },
    applyConstraints: async (constraints) => {
      calls.push('apply');
      if (browser === 'firefox') adopt(constraints);
    },
    restartTrack: async (options) => {
      calls.push('restart');
      restartedWith = options;
      adopt(options);
    },
  };
  return { track, calls, restartedWith: () => restartedWith, current: () => current };
}

describe('applyCaptureProcessing', () => {
  it('não toca no microfone que já está como pedido', async () => {
    const fake = fakeTrack('chrome', RAW_WITH_ECHO);
    await applyCaptureProcessing(fake.track, RAW_WITH_ECHO);
    expect(fake.calls).toEqual([]);
  });

  it('reabre o microfone quando o navegador aceita a troca e não aplica (Chrome)', async () => {
    const fake = fakeTrack('chrome', ON);
    await applyCaptureProcessing(fake.track, RAW_WITH_ECHO);
    expect(fake.calls).toEqual(['apply', 'restart']);
    expect(fake.current()).toEqual(RAW_WITH_ECHO);
  });

  it('reabre no MESMO aparelho, com o resto da captura intacto', async () => {
    const fake = fakeTrack('chrome', RAW_WITH_ECHO);
    await applyCaptureProcessing(fake.track, ON);
    expect(fake.restartedWith()).toEqual({
      deviceId: { exact: 'microfone-usb' },
      echoCancellation: { ideal: true },
      autoGainControl: { ideal: true },
      noiseSuppression: { ideal: true },
      voiceIsolation: { ideal: true },
    });
  });

  it('desligar só o cancelamento de eco também reabre, e mantém o resto', async () => {
    const fake = fakeTrack('chrome', RAW_WITH_ECHO);
    await applyCaptureProcessing(fake.track, RAW);
    expect(fake.calls).toEqual(['apply', 'restart']);
    expect(fake.restartedWith()).toMatchObject({
      deviceId: { exact: 'microfone-usb' },
      echoCancellation: { ideal: false },
      noiseSuppression: { ideal: false },
    });
    expect(fake.current()).toEqual(RAW);
  });

  it('não reabre quando applyConstraints resolve de verdade (Firefox)', async () => {
    const fake = fakeTrack('firefox', ON);
    await applyCaptureProcessing(fake.track, RAW);
    expect(fake.calls).toEqual(['apply']);
    expect(fake.current()).toEqual(RAW);
  });

  it('reabre quando applyConstraints é recusado', async () => {
    const fake = fakeTrack('chrome', ON);
    fake.track.applyConstraints = async () => {
      fake.calls.push('apply');
      throw new DOMException('não suportado', 'OverconstrainedError');
    };
    await applyCaptureProcessing(fake.track, RAW_WITH_ECHO);
    expect(fake.calls).toEqual(['apply', 'restart']);
  });

  it('sem como conferir o estado, não reabre o microfone às cegas', async () => {
    const fake = fakeTrack('calado', ON);
    await applyCaptureProcessing(fake.track, RAW);
    expect(fake.calls).toEqual(['apply']);
  });
});
