import { useEffect } from 'react';
import { useLocalParticipant } from '@livekit/components-react';
import { LocalAudioTrack, Track, type LocalTrackPublication } from 'livekit-client';
import {
  SCREEN_AUDIO_PROFILE,
  VOICE_PROFILE,
  auditAudioSender,
  describeAudit,
  type AudioSendProfile,
  type OutboundSample,
} from '../lib/audioSendProfile';

/** Espera o controle de banda subir o encoder antes de medir. */
const SETTLE_MS = 8_000;
/** Janela da medição de bitrate. */
const MEASURE_MS = 5_000;

async function readOutbound(sender: RTCRtpSender): Promise<OutboundSample | undefined> {
  const report = await sender.getStats();
  for (const stat of report.values()) {
    if (stat.type !== 'outbound-rtp') continue;
    const outbound = stat as RTCOutboundRtpStreamStats & { targetBitrate?: number };
    const codec = outbound.codecId === undefined ? undefined : (report.get(outbound.codecId) as RTCRtpCodec | undefined);
    return {
      timestamp: outbound.timestamp,
      bytesSent: outbound.bytesSent ?? 0,
      targetBitrate: outbound.targetBitrate,
      codecMimeType: codec?.mimeType,
    };
  }
  return undefined;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      window.clearTimeout(timer);
      reject(signal.reason);
    });
  });
}

async function audit(label: string, track: LocalAudioTrack, profile: AudioSendProfile, signal: AbortSignal): Promise<void> {
  await delay(SETTLE_MS, signal);
  const sender = track.sender;
  if (sender === undefined) return;
  const first = await readOutbound(sender);
  await delay(MEASURE_MS, signal);
  const second = await readOutbound(sender);

  const parameters = sender.getParameters();
  const settings = track.mediaStreamTrack.getSettings();
  const result = auditAudioSender(
    {
      maxBitrate: parameters.encodings[0]?.maxBitrate,
      codecs: parameters.codecs ?? [],
      sampleRate: settings.sampleRate,
      // Só o microfone pede canal fixo na captura; a tela entrega o que a
      // fonte tem, e o estéreo dela é decidido na negociação.
      channelCount: profile.stereo ? undefined : settings.channelCount,
      first,
      second,
    },
    profile,
  );
  const line = describeAudit(label, result, profile);
  if (result.ok) console.info(line);
  else console.warn(line);
}

function useAuditPublication(
  publication: LocalTrackPublication | undefined,
  label: string,
  profile: AudioSendProfile,
): void {
  const track = publication?.track instanceof LocalAudioTrack ? publication.track : null;

  useEffect(() => {
    if (track === null) return;
    const controller = new AbortController();
    audit(label, track, profile, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [track, label, profile]);
}

/**
 * Confere, no navegador, que o áudio que SAI é o que `audioSendProfile.ts`
 * programou: teto do sender, codec, RED, DTX, taxa de captura e o bitrate
 * medido no fio. Uma linha no console por track publicada — `info` quando
 * confere, `warn` com o que diverge.
 *
 * É a metade em runtime dos testes de `audioSendProfile.test.ts`: o teste
 * garante que a configuração e a auditoria estão certas; isto garante que o
 * navegador e o servidor de verdade não desfizeram nada no caminho.
 */
export function useAudioSendAudit(): void {
  const { localParticipant } = useLocalParticipant();
  useAuditPublication(localParticipant.getTrackPublication(Track.Source.Microphone), 'microfone', VOICE_PROFILE);
  useAuditPublication(
    localParticipant.getTrackPublication(Track.Source.ScreenShareAudio),
    'áudio da tela',
    SCREEN_AUDIO_PROFILE,
  );
}
