/**
 * localStorage guarda APENAS a preferência de nome (SPEC §3).
 * Modo privado e storage bloqueado não podem derrubar o app.
 */
import { DEFAULT_SCREEN_QUALITY, type ScreenQualityId } from './media';

/** Ids válidos, para recusar lixo vindo do localStorage. */
const SCREEN_QUALITY_IDS: ScreenQualityId[] = ['suave', 'equilibrada', 'alta', 'maxima'];

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

// ---------------------------------------------------------------------------
// Soundboard e painéis
// ---------------------------------------------------------------------------

const SOUND_VOLUME_KEY = 'telecord.soundVolume';
const SOUND_MUTED_KEY = 'telecord.soundMuted';
const PANEL_WIDTH_PREFIX = 'telecord.panel.';

const DEFAULT_SOUND_VOLUME = 0.7;

/** 0..1. Volume LOCAL: controla quanto esta pessoa ouve, não os outros. */
export function readSoundVolume(): number {
  try {
    const stored = window.localStorage.getItem(SOUND_VOLUME_KEY);
    // A checagem de null vem ANTES da conversão: Number(null) é 0, que passa
    // na validação de faixa e faria a chave ausente virar volume zerado —
    // ou seja, o padrão nunca seria usado e ninguém ouviria som nenhum.
    if (stored === null) {
      return DEFAULT_SOUND_VOLUME;
    }
    const raw = Number(stored);
    return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_SOUND_VOLUME;
  } catch {
    return DEFAULT_SOUND_VOLUME;
  }
}

export function writeSoundVolume(volume: number): void {
  try {
    window.localStorage.setItem(SOUND_VOLUME_KEY, String(volume));
  } catch {
    // Storage indisponível.
  }
}

export function readSoundMuted(): boolean {
  try {
    return window.localStorage.getItem(SOUND_MUTED_KEY) === 'yes';
  } catch {
    return false;
  }
}

export function writeSoundMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(SOUND_MUTED_KEY, muted ? 'yes' : 'no');
  } catch {
    // Storage indisponível.
  }
}

export function readPanelWidth(name: string, fallback: number): number {
  try {
    const raw = Number(window.localStorage.getItem(PANEL_WIDTH_PREFIX + name));
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  } catch {
    return fallback;
  }
}

export function writePanelWidth(name: string, width: number): void {
  try {
    window.localStorage.setItem(PANEL_WIDTH_PREFIX + name, String(Math.round(width)));
  } catch {
    // Storage indisponível.
  }
}

// ---------------------------------------------------------------------------
// Volume individual por participante
// ---------------------------------------------------------------------------

/**
 * 0..2 (0% a 200%). Guardado por `identity`, não por nome: o nome pode mudar
 * de sala para sala ou entre contas, a `identity` é o que o SFU usa para
 * saber que é a mesma pessoa que estava aqui antes.
 *
 * É preferência DESTA pessoa sobre a voz das outras — nunca sincroniza entre
 * clientes, nunca sobe para o servidor. Cada um ajusta o que ouve dos outros,
 * do jeito que o volume do soundboard já funciona.
 */
const PEER_VOLUME_PREFIX = 'telecord.peerVolume.';
const PEER_MUTED_PREFIX = 'telecord.peerMuted.';

export function readPeerVolume(identity: string): number {
  try {
    const raw = window.localStorage.getItem(PEER_VOLUME_PREFIX + identity);
    if (raw === null) {
      return 1;
    }
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 2 ? value : 1;
  } catch {
    return 1;
  }
}

export function writePeerVolume(identity: string, volume: number): void {
  try {
    window.localStorage.setItem(PEER_VOLUME_PREFIX + identity, String(volume));
  } catch {
    // Storage indisponível: o ajuste vale só para esta sessão da aba.
  }
}

export function readPeerMuted(identity: string): boolean {
  try {
    return window.localStorage.getItem(PEER_MUTED_PREFIX + identity) === 'yes';
  } catch {
    return false;
  }
}

export function writePeerMuted(identity: string, muted: boolean): void {
  try {
    window.localStorage.setItem(PEER_MUTED_PREFIX + identity, muted ? 'yes' : 'no');
  } catch {
    // Storage indisponível.
  }
}

const SCREEN_QUALITY_KEY = 'telecord.screenQuality';

/**
 * Qualidade escolhida para o compartilhamento de tela.
 *
 * Preferência por máquina, e não por sala: quem está num link apertado quer o
 * nível baixo em toda sala que entrar, e quem tem fibra não quer reescolher
 * "máxima" toda vez. Valor desconhecido (versão antiga, storage adulterado)
 * cai no padrão em vez de quebrar.
 */
export function readScreenQuality(): ScreenQualityId {
  try {
    const raw = window.localStorage.getItem(SCREEN_QUALITY_KEY);
    return SCREEN_QUALITY_IDS.includes(raw as ScreenQualityId)
      ? (raw as ScreenQualityId)
      : DEFAULT_SCREEN_QUALITY;
  } catch {
    return DEFAULT_SCREEN_QUALITY;
  }
}

export function writeScreenQuality(id: ScreenQualityId): void {
  try {
    window.localStorage.setItem(SCREEN_QUALITY_KEY, id);
  } catch {
    // Storage indisponível: a escolha vale só para esta aba.
  }
}
