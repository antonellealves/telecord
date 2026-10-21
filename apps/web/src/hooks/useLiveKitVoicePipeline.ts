import { useCallback, useEffect, useRef, useState } from 'react';
import { useRoomContext } from '@livekit/components-react';
import {
  LocalAudioTrack,
  ParticipantEvent,
  RemoteAudioTrack,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type Room,
} from 'livekit-client';
import { voicePreset } from '../lib/media';
import {
  PREFERRED_DEVICE_EVENT,
  VOICE_BITRATE_EVENT,
  readPreferredDevice,
  readVoiceBitrate,
  writeVoiceBitrate,
  type PreferredDeviceChange,
  type VoiceBitrateChange,
} from '../lib/storage';
import { preferOpusOnly } from '../lib/voice/codecPreferences';
import { attachVoiceFrameTransform } from '../lib/voice/frameTransform';
import { resolveInputDevice } from '../lib/voice/inputDevice';
import type { VoiceBitrate } from '../lib/voice/voiceProfile';
import type { VoiceStatsSource } from '../components/VoiceDebugPanel';

/**
 * O formato que `PCTransport.setTrackCodecBitrate` guarda. O LiveKit lê esta
 * entrada a cada resposta do servidor e reescreve o `maxaveragebitrate` do
 * Opus na seção do transceiver — é o munging de SDP que o próprio SDK faz
 * para o Firefox, aqui usado também no Chrome.
 */
interface CodecBitrateHint {
  transceiver?: RTCRtpTransceiver;
  codec: string;
  /** Em kbps, como o SDK espera. */
  maxbr: number;
}

function publisherOf(room: Room) {
  return room.engine?.pcManager?.publisher;
}

function micTrack(room: Room): LocalAudioTrack | null {
  const track = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
  return track instanceof LocalAudioTrack ? track : null;
}

async function applySenderBitrate(sender: RTCRtpSender | undefined, bitrate: number): Promise<void> {
  if (sender === undefined) return;
  const params = sender.getParameters();
  if (params.encodings === undefined || params.encodings.length === 0) params.encodings = [{}];
  params.encodings = params.encodings.map((encoding) => ({ ...encoding, maxBitrate: bitrate }));
  await sender.setParameters(params);
}

export interface LiveKitVoicePipeline {
  bitrate: VoiceBitrate;
  setBitrate: (bitrate: VoiceBitrate) => void;
  /** Para o painel de debug: o microfone e cada voz remota. */
  getStatsSources: () => VoiceStatsSource[];
}

/**
 * O pipeline de voz da sala LiveKit no formato do Discord, onde o SDK deixa
 * mexer:
 *
 * - **Opus só** — `setCodecPreferences` no transceiver do microfone, no
 *   instante em que o SDK o cria (`LocalSenderCreated`, o mesmo evento que o
 *   E2EE do próprio SDK usa) e antes da oferta sair.
 * - **Teto da sala** — `maxBitrate` no `RTCRtpSender` (`setParameters`) e o
 *   mesmo valor no `maxaveragebitrate` da resposta, no lugar dos 510000 que
 *   o servidor manda. Os dois juntos garantem `targetBitrate` igual ao teto
 *   com ou sem transport-cc no áudio.
 * - **Microfone pelo id exato** — resolve o aparelho de verdade (nunca
 *   `default`) ao entrar, a cada escolha e a cada `devicechange`, e troca a
 *   track com `switchActiveDevice(…, exact)`: por baixo é `replaceTrack`, sem
 *   renegociar.
 * - **Gancho de E2EE** — `RTCRtpScriptTransform` no sender e nos receivers
 *   de voz, atrás da flag (ver `frameTransform.ts`).
 *
 * DTX, FEC e RED vêm das opções de publicação (`media.ts`); a supressão de
 * ruído e o cancelamento de eco, de `useNoiseFilter`.
 */
export function useLiveKitVoicePipeline(roomId: string): LiveKitVoicePipeline {
  const room = useRoomContext();
  const [bitrate, setBitrateState] = useState<VoiceBitrate>(() => readVoiceBitrate(roomId));
  const bitrateRef = useRef(bitrate);
  bitrateRef.current = bitrate;
  const hintRef = useRef<CodecBitrateHint | null>(null);

  // A escolha vem do painel por evento — o mesmo caminho nos dois transportes.
  useEffect(() => {
    setBitrateState(readVoiceBitrate(roomId));
    const handle = (event: Event): void => {
      const { detail } = event as CustomEvent<VoiceBitrateChange>;
      if (detail.roomId === roomId) setBitrateState(detail.bitrate);
    };
    window.addEventListener(VOICE_BITRATE_EVENT, handle);
    return () => window.removeEventListener(VOICE_BITRATE_EVENT, handle);
  }, [roomId]);

  const setBitrate = useCallback((next: VoiceBitrate) => writeVoiceBitrate(roomId, next), [roomId]);

  // Teto: na próxima publicação e no microfone que estiver no ar.
  useEffect(() => {
    room.options.publishDefaults = { ...room.options.publishDefaults, audioPreset: voicePreset(bitrate) };
    const hint = hintRef.current;
    const track = micTrack(room);
    if (track === null) return;
    void applySenderBitrate(track.sender, bitrate).catch(() => undefined);
    if (hint !== null && hint.maxbr !== bitrate / 1000) {
      hint.maxbr = bitrate / 1000;
      // O `maxaveragebitrate` só muda numa nova negociação.
      void room.engine?.negotiate().catch(() => undefined);
    }
  }, [room, bitrate]);

  // O microfone nasce Opus-only, com o teto também no SDP.
  useEffect(() => {
    const local = room.localParticipant;
    const handleSender = (sender: RTCRtpSender, track: Track): void => {
      if (track.source !== Track.Source.Microphone) return;
      const publisher = publisherOf(room);
      const transceiver = publisher?.getTransceivers().find((entry) => entry.sender === sender);
      if (publisher !== undefined && transceiver !== undefined) {
        preferOpusOnly(transceiver);
        const hint: CodecBitrateHint = { transceiver, codec: 'opus', maxbr: bitrateRef.current / 1000 };
        publisher.setTrackCodecBitrate(hint);
        hintRef.current = hint;
      }
      attachVoiceFrameTransform(sender, { direction: 'send', trackKind: 'mic', peerId: local.identity });
    };
    const handleUnpublished = (publication: LocalTrackPublication): void => {
      if (publication.source !== Track.Source.Microphone || hintRef.current === null) return;
      // Sem transceiver a entrada deixa de valer — o SDK pula entradas assim.
      // Isso evita o teto da voz ir parar no áudio da tela, se a seção for
      // reaproveitada.
      hintRef.current.transceiver = undefined;
      hintRef.current = null;
    };
    local.on(ParticipantEvent.LocalSenderCreated, handleSender);
    local.on(ParticipantEvent.LocalTrackUnpublished, handleUnpublished);
    return () => {
      local.off(ParticipantEvent.LocalSenderCreated, handleSender);
      local.off(ParticipantEvent.LocalTrackUnpublished, handleUnpublished);
    };
  }, [room]);

  // Microfone pelo id exato, seguindo a escolha e o que estiver plugado.
  useEffect(() => {
    let alive = true;
    let queue: Promise<void> = Promise.resolve();
    const sync = (): void => {
      queue = queue
        .then(async () => {
          if (!alive || navigator.mediaDevices?.enumerateDevices === undefined) return;
          const devices = await navigator.mediaDevices.enumerateDevices();
          const target = resolveInputDevice(devices, readPreferredDevice('audioinput'));
          if (!alive || target === null) return;
          const track = micTrack(room);
          const current = track?.mediaStreamTrack.getSettings().deviceId ?? room.getActiveDevice('audioinput');
          if (current === target) return;
          await room.switchActiveDevice('audioinput', target, true);
        })
        .catch(() => undefined);
    };
    const handlePreference = (event: Event): void => {
      if ((event as CustomEvent<PreferredDeviceChange>).detail.kind === 'audioinput') sync();
    };
    // Sem permissão, a primeira lista vem sem ids; quando o microfone abre
    // pela primeira vez, ela passa a ter — e a captura vai para o id exato.
    const handlePublished = (publication: LocalTrackPublication): void => {
      if (publication.source === Track.Source.Microphone) sync();
    };

    sync();
    navigator.mediaDevices?.addEventListener?.('devicechange', sync);
    window.addEventListener(PREFERRED_DEVICE_EVENT, handlePreference);
    room.localParticipant.on(ParticipantEvent.LocalTrackPublished, handlePublished);
    return () => {
      alive = false;
      navigator.mediaDevices?.removeEventListener?.('devicechange', sync);
      window.removeEventListener(PREFERRED_DEVICE_EVENT, handlePreference);
      room.localParticipant.off(ParticipantEvent.LocalTrackPublished, handlePublished);
    };
  }, [room]);

  // Gancho de E2EE na recepção das vozes.
  useEffect(() => {
    const handle = (track: RemoteTrack, _publication: RemoteTrackPublication, participant: RemoteParticipant): void => {
      if (!(track instanceof RemoteAudioTrack) || track.receiver === undefined) return;
      attachVoiceFrameTransform(track.receiver, {
        direction: 'recv',
        trackKind: track.source === Track.Source.ScreenShareAudio ? 'screen-audio' : 'mic',
        peerId: participant.identity,
      });
    };
    room.on(RoomEvent.TrackSubscribed, handle);
    return () => {
      room.off(RoomEvent.TrackSubscribed, handle);
    };
  }, [room]);

  const getStatsSources = useCallback((): VoiceStatsSource[] => {
    const sources: VoiceStatsSource[] = [];
    const track = micTrack(room);
    if (track !== null && track.sender !== undefined) {
      const sender = track.sender;
      sources.push({ id: 'local-mic', label: 'Você · microfone', direction: 'send', getStats: () => sender.getStats() });
    }
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.audioTrackPublications.values()) {
        const remote = publication.track;
        if (!(remote instanceof RemoteAudioTrack) || remote.receiver === undefined) continue;
        const receiver = remote.receiver;
        const isScreen = publication.source === Track.Source.ScreenShareAudio;
        sources.push({
          id: `${participant.identity}:${publication.trackSid}`,
          label: `${participant.name || participant.identity}${isScreen ? ' · áudio da tela' : ''}`,
          direction: 'recv',
          getStats: () => receiver.getStats(),
        });
      }
    }
    return sources;
  }, [room]);

  return { bitrate, setBitrate, getStatsSources };
}
