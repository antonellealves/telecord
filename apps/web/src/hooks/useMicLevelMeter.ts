import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { describeMicrophoneError } from '../lib/errors';
import { resolveInputDevice } from '../lib/voice/inputDevice';
import { DeadMicDetector, meterLevel, rmsOf } from '../lib/voice/micLevel';
import { voiceCaptureConstraints } from '../lib/voice/voiceProfile';

export type MicLevelState = 'off' | 'starting' | 'live' | 'dead' | 'error';

export interface MicLevelMeter {
  state: MicLevelState;
  error: string | null;
  /** Recebe `--level` (0..1) a cada quadro, direto no DOM. */
  meterRef: MutableRefObject<HTMLDivElement | null>;
}

interface Options {
  /** A escolha guardada (`''`/`default` = padrão do sistema). */
  preferredDevice: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  enabled: boolean;
}

/**
 * Medidor de nível AO VIVO do microfone escolhido, para a tela de
 * configurações — o que o Discord mostra para a pessoa ver, antes de falar
 * na sala, que o aparelho certo está captando.
 *
 * Abre uma captura própria (o mesmo aparelho e o mesmo processamento da
 * sala), independente do microfone da sala: funciona com ele desligado e não
 * mexe nele. Só ouve: nada é tocado de volta, então não há microfonia.
 *
 * O nível vai para o DOM como custom property, sem estado React por quadro.
 */
export function useMicLevelMeter({ preferredDevice, noiseSuppression, echoCancellation, enabled }: Options): MicLevelMeter {
  const [state, setState] = useState<MicLevelState>('off');
  const [error, setError] = useState<string | null>(null);
  const meterRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!enabled) {
      setState('off');
      return;
    }
    let alive = true;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let frame = 0;
    setState('starting');
    setError(null);

    void (async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const deviceId = resolveInputDevice(devices, preferredDevice);
        stream = await navigator.mediaDevices.getUserMedia({
          audio: voiceCaptureConstraints({ deviceId, noiseSuppression, echoCancellation }),
        });
        if (!alive) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);
        const detector = new DeadMicDetector(performance.now());
        let dead = false;
        setState('live');

        const draw = (): void => {
          analyser.getFloatTimeDomainData(samples);
          const rms = rmsOf(samples);
          const now = performance.now();
          detector.push(rms, now);
          meterRef.current?.style.setProperty('--level', meterLevel(rms).toFixed(3));
          const deadNow = detector.isDead(now);
          if (deadNow !== dead) {
            dead = deadNow;
            setState(deadNow ? 'dead' : 'live');
          }
          frame = requestAnimationFrame(draw);
        };
        draw();
      } catch (failure) {
        if (!alive) return;
        setState('error');
        setError(describeMicrophoneError(failure));
      }
    })();

    return () => {
      alive = false;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close();
      meterRef.current?.style.setProperty('--level', '0');
    };
  }, [enabled, preferredDevice, noiseSuppression, echoCancellation]);

  return { state, error, meterRef };
}
