import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { describeMicrophoneError } from '../lib/errors';

export type MicrophoneTestState = 'idle' | 'recording' | 'playing';

export interface MicrophoneTest {
  state: MicrophoneTestState;
  /** Segundos restantes de gravação. */
  secondsLeft: number;
  /** Recebe `--level` (0..1) a cada frame — ver comentário abaixo. */
  meterRef: MutableRefObject<HTMLDivElement | null>;
  supported: boolean;
  start: () => void;
  cancel: () => void;
}

const RECORD_SECONDS = 4;

/**
 * Teste de microfone: grava alguns segundos e toca de volta.
 *
 * Grava-e-reproduz em vez de monitorar ao vivo de propósito. Monitoração ao
 * vivo em quem está de caixa de som vira microfonia imediata — o som sai,
 * volta pelo microfone e realimenta. Gravar e tocar depois é o único jeito
 * seguro de "ouvir você mesmo" sem exigir fone.
 *
 * De quebra, testa a saída junto: a reprodução vai pelo dispositivo escolhido
 * no painel, quando o navegador permite escolher saída.
 *
 * O medidor de nível é escrito direto no DOM como custom property, e não em
 * estado React: são ~60 atualizações por segundo, e re-renderizar o painel
 * inteiro nesse ritmo é desperdício puro.
 */
export function useMicrophoneTest(
  getOutputDeviceId: () => string,
  onError: (message: string) => void,
): MicrophoneTest {
  const [state, setState] = useState<MicrophoneTestState>('idle');
  const [secondsLeft, setSecondsLeft] = useState(RECORD_SECONDS);
  const meterRef = useRef<HTMLDivElement | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const frameRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const getOutputRef = useRef(getOutputDeviceId);
  getOutputRef.current = getOutputDeviceId;

  const supported =
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function';

  const cleanup = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (recorderRef.current !== null && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void contextRef.current?.close();
    contextRef.current = null;
    if (audioRef.current !== null) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (urlRef.current !== null) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    if (meterRef.current !== null) {
      meterRef.current.style.setProperty('--level', '0');
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const playBack = useCallback(async (blob: Blob): Promise<void> => {
    const url = URL.createObjectURL(blob);
    urlRef.current = url;
    const audio = new Audio(url);
    audioRef.current = audio;

    // Toca pela saída escolhida no painel, quando o navegador deixa.
    const outputId = getOutputRef.current();
    const withSink = audio as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (outputId !== '' && outputId !== 'default' && typeof withSink.setSinkId === 'function') {
      await withSink.setSinkId(outputId).catch(() => undefined);
    }

    audio.addEventListener(
      'ended',
      () => {
        setState('idle');
        cleanup();
      },
      { once: true },
    );

    try {
      await audio.play();
      setState('playing');
    } catch {
      onErrorRef.current('O navegador bloqueou a reprodução do teste.');
      setState('idle');
      cleanup();
    }
  }, [cleanup]);

  const start = useCallback(() => {
    if (state !== 'idle' || !supported) {
      return;
    }

    setSecondsLeft(RECORD_SECONDS);

    void navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        streamRef.current = stream;
        setState('recording');

        // Medidor: RMS da janela de tempo, escrito como custom property.
        const context = new AudioContext();
        contextRef.current = context;
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        context.createMediaStreamSource(stream).connect(analyser);
        const samples = new Float32Array(analyser.fftSize);

        const drawMeter = (): void => {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const sample of samples) {
            sum += sample * sample;
          }
          const rms = Math.sqrt(sum / samples.length);
          // Escala levemente comprimida: fala normal ocupa boa parte da barra
          // em vez de ficar espremida embaixo.
          const level = Math.min(1, Math.sqrt(rms) * 2.4);
          meterRef.current?.style.setProperty('--level', level.toFixed(3));
          frameRef.current = requestAnimationFrame(drawMeter);
        };
        drawMeter();

        const chunks: Blob[] = [];
        const recorder = new MediaRecorder(stream);
        recorderRef.current = recorder;
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        });
        recorder.addEventListener('stop', () => {
          cancelAnimationFrame(frameRef.current);
          meterRef.current?.style.setProperty('--level', '0');
          streamRef.current?.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
          if (chunks.length === 0) {
            setState('idle');
            return;
          }
          void playBack(new Blob(chunks, { type: recorder.mimeType }));
        });
        recorder.start();

        timerRef.current = setInterval(() => {
          setSecondsLeft((left) => {
            if (left <= 1) {
              if (timerRef.current !== null) {
                clearInterval(timerRef.current);
                timerRef.current = null;
              }
              if (recorderRef.current?.state === 'recording') {
                recorderRef.current.stop();
              }
              return 0;
            }
            return left - 1;
          });
        }, 1000);
      })
      .catch((error: unknown) => {
        onErrorRef.current(describeMicrophoneError(error));
        setState('idle');
        cleanup();
      });
  }, [state, supported, cleanup, playBack]);

  const cancel = useCallback(() => {
    setState('idle');
    setSecondsLeft(RECORD_SECONDS);
    cleanup();
  }, [cleanup]);

  return { state, secondsLeft, meterRef, supported, start, cancel };
}
