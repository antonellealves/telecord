/**
 * localStorage guarda APENAS a preferência de nome (SPEC §3).
 * Modo privado e storage bloqueado não podem derrubar o app.
 */
const DISPLAY_NAME_KEY = 'telecord.displayName';

export function readStoredDisplayName(): string {
  try {
    return window.localStorage.getItem(DISPLAY_NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeStoredDisplayName(value: string): void {
  try {
    window.localStorage.setItem(DISPLAY_NAME_KEY, value);
  } catch {
    // Storage indisponível: o nome vale só para esta aba. Não é erro fatal.
  }
}

/** Voz aberta ou "aperte para falar". */
export type TalkMode = 'open' | 'push';

const TALK_MODE_KEY = 'telecord.talkMode';

export function readTalkMode(): TalkMode {
  try {
    return window.localStorage.getItem(TALK_MODE_KEY) === 'push' ? 'push' : 'open';
  } catch {
    return 'open';
  }
}

export function writeTalkMode(mode: TalkMode): void {
  try {
    window.localStorage.setItem(TALK_MODE_KEY, mode);
  } catch {
    // Storage indisponível: o modo vale só para esta aba.
  }
}

const NOISE_SUPPRESSION_KEY = 'telecord.noiseSuppression';

export function readNoiseSuppression(): boolean {
  try {
    // Ligado é o padrão: sala de voz com ruído de fundo cansa rápido.
    return window.localStorage.getItem(NOISE_SUPPRESSION_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function writeNoiseSuppression(enabled: boolean): void {
  try {
    window.localStorage.setItem(NOISE_SUPPRESSION_KEY, enabled ? 'on' : 'off');
  } catch {
    // Storage indisponível: vale só para esta aba.
  }
}

// ---------------------------------------------------------------------------
// Volta do usuário
// ---------------------------------------------------------------------------

const LAST_ROOM_KEY = 'telecord.lastRoom';
const MIC_GRANTED_KEY = 'telecord.micGranted';
const DEVICE_KEY_PREFIX = 'telecord.device.';

export function readLastRoom(): string {
  try {
    return window.localStorage.getItem(LAST_ROOM_KEY) ?? '';
  } catch {
    return '';
  }
}

export function writeLastRoom(roomId: string): void {
  try {
    window.localStorage.setItem(LAST_ROOM_KEY, roomId);
  } catch {
    // Storage indisponível.
  }
}

/**
 * Lembrete de que o microfone já foi autorizado neste navegador.
 *
 * É uma DICA, não a fonte de verdade: quem decide é o navegador, e a pessoa
 * pode revogar a permissão a qualquer momento sem avisar a página. Serve para
 * a interface não pedir de novo quem já autorizou, e é sempre conferida contra
 * a Permissions API quando ela existe.
 */
export function readMicrophoneGranted(): boolean {
  try {
    return window.localStorage.getItem(MIC_GRANTED_KEY) === 'yes';
  } catch {
    return false;
  }
}

export function writeMicrophoneGranted(granted: boolean): void {
  try {
    window.localStorage.setItem(MIC_GRANTED_KEY, granted ? 'yes' : 'no');
  } catch {
    // Storage indisponível.
  }
}

export function readPreferredDevice(kind: MediaDeviceKind): string {
  try {
    return window.localStorage.getItem(DEVICE_KEY_PREFIX + kind) ?? '';
  } catch {
    return '';
  }
}

export function writePreferredDevice(kind: MediaDeviceKind, deviceId: string): void {
  try {
    window.localStorage.setItem(DEVICE_KEY_PREFIX + kind, deviceId);
  } catch {
    // Storage indisponível.
  }
}
