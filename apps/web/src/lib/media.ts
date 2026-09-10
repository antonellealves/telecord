import {
  AudioPresets,
  ScreenSharePresets,
  VideoPresets,
  type RoomOptions,
  type ScreenShareCaptureOptions,
  type TrackPublishOptions,
  type VideoCaptureOptions,
} from 'livekit-client';

/** SPEC §6.1. */
export const roomOptions: RoomOptions = {
  adaptiveStream: true,
  dynacast: true,
  publishDefaults: {
    dtx: true,
    red: true,
    audioPreset: AudioPresets.speech,
    stopMicTrackOnMute: false,
    videoCodec: 'vp8',
    screenShareEncoding: ScreenSharePresets.h1080fps15.encoding,
    simulcast: false,
  },
  audioCaptureDefaults: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  },
};

/** SPEC §6.2 e §6.3. */
export const screenShareCaptureOptions: ScreenShareCaptureOptions = {
  // O áudio da aba só existe em Chromium desktop; quando vier, sobe sem
  // processamento de voz — o AEC destruiria o áudio do conteúdo.
  audio: {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  },
  contentHint: 'detail',
  resolution: ScreenSharePresets.h1080fps15.resolution,
  selfBrowserSurface: 'exclude',
  surfaceSwitching: 'include',
  // 'exclude' faz o navegador oferecer só o áudio da aba/janela escolhida,
  // em vez do som do sistema inteiro — sem isso, notificação e qualquer outro
  // programa entram junto na sala.
  systemAudio: 'exclude',
};

/** SPEC §6.9. */
export const cameraCaptureOptions: VideoCaptureOptions = {
  resolution: VideoPresets.h360.resolution,
  facingMode: 'user',
};

/**
 * Simulcast SÓ na câmera.
 *
 * As opções de publicação são passadas por chamada em `setCameraEnabled`, e
 * não nos defaults do Room, de propósito: assim a tela compartilhada mantém a
 * decisão da §6.4 de publicar uma camada só. Câmera é o caso oposto — muitos
 * assistindo em quadro pequeno —, e a camada de 180p é o que permite ao SFU
 * mandar pouco para quem não está olhando de perto.
 */
export const cameraPublishOptions: TrackPublishOptions = {
  simulcast: true,
  videoEncoding: VideoPresets.h360.encoding,
  videoSimulcastLayers: [VideoPresets.h180],
};

/** Slug curto e digitável para quando o campo de sala vem vazio. */
export function generateRoomId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  let value = 0;
  for (const byte of bytes) {
    value = value * 256 + byte;
  }
  return `sala-${value.toString(36).padStart(6, '0').slice(-6)}`;
}
