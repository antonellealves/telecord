import { useCallback, useEffect, useState } from 'react';
import { VOICE_BITRATE_EVENT, readVoiceBitrate, writeVoiceBitrate, type VoiceBitrateChange } from '../../lib/storage';
import type { VoiceBitrate } from '../../lib/voice/voiceProfile';
import type { VoiceStatsSource } from '../../components/VoiceDebugPanel';
import type { MediasoupEngine } from './useMediasoupEngine';

export interface MediasoupVoice {
  bitrate: VoiceBitrate;
  setBitrate: (bitrate: VoiceBitrate) => void;
  getStatsSources: () => VoiceStatsSource[];
}

/**
 * Teto da voz da sala e as fontes do painel de debug, no mediasoup — o par
 * de `useLiveKitVoicePipeline`. O resto do pipeline (captura, troca de
 * aparelho, SDP) fica em `useMediasoupTalkControls` e `voiceDevice.ts`.
 */
export function useMediasoupVoice(engine: MediasoupEngine, roomId: string): MediasoupVoice {
  const [bitrate, setBitrateState] = useState<VoiceBitrate>(() => readVoiceBitrate(roomId));

  useEffect(() => {
    setBitrateState(readVoiceBitrate(roomId));
    const handle = (event: Event): void => {
      const { detail } = event as CustomEvent<VoiceBitrateChange>;
      if (detail.roomId === roomId) setBitrateState(detail.bitrate);
    };
    window.addEventListener(VOICE_BITRATE_EVENT, handle);
    return () => window.removeEventListener(VOICE_BITRATE_EVENT, handle);
  }, [roomId]);

  useEffect(() => {
    engine.connection?.setVoiceBitrate(bitrate);
  }, [engine.connection, bitrate]);

  const setBitrate = useCallback((next: VoiceBitrate) => writeVoiceBitrate(roomId, next), [roomId]);
  const getStatsSources = useCallback(
    (): VoiceStatsSource[] => engine.connection?.getVoiceStatsSources() ?? [],
    [engine.connection],
  );

  return { bitrate, setBitrate, getStatsSources };
}
