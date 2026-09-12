/**
 * localStorage guarda APENAS a preferência de nome (SPEC §3).
 * Modo privado e storage bloqueado não podem derrubar o app.
 */
import type { TransportMode } from '@telecord/shared';
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

const PARTICIPANTS_OPEN_KEY = 'telecord.participantsOpen';

/**
 * Lista de participantes visível ou escondida.
 *
 * Aberta por padrão: saber quem está na sala é o estado normal, e quem nunca
 * mexeu não deve entrar numa sala sem a lista. Guardado porque esconder é uma
 * escolha de espaço de tela — vale para todas as salas, não para uma.
 */
export function readParticipantsOpen(): boolean {
  try {
    return window.localStorage.getItem(PARTICIPANTS_OPEN_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function writeParticipantsOpen(open: boolean): void {
  try {
    window.localStorage.setItem(PARTICIPANTS_OPEN_KEY, open ? 'true' : 'false');
  } catch {
    // Storage indisponível: a escolha vale só para esta aba.
  }
}

const TRANSPORT_KEY = 'telecord.transport';

/**
 * Qual pilha de transmissão usar: o SFU (LiveKit) ou a malha direta (P2P).
 *
 * `livekit` é o padrão e continua sendo: é o que aguenta sala cheia, o que
 * funciona atrás de NAT difícil e o que tem soundboard, chat e gravação de
 * sessão. O P2P é escolha consciente de quem quer latência menor ou não quer a
 * mídia passando por servidor nenhum — e aceita o teto de gente.
 */
export function readTransport(): TransportMode {
  try {
    const raw = window.localStorage.getItem(TRANSPORT_KEY);
    return raw === 'p2p' || raw === 'cfsfu' ? raw : 'livekit';
  } catch {
    return 'livekit';
  }
}

export function writeTransport(mode: TransportMode): void {
  try {
    window.localStorage.setItem(TRANSPORT_KEY, mode);
  } catch {
    // Storage indisponível: a escolha vale só para esta aba.
  }
}

// ---------------------------------------------------------------------------
// Edge global (Cloudflare Realtime SFU)
// ---------------------------------------------------------------------------

const CFSFU_BITRATE_KEY = 'telecord.cfsfu.bitrate';
const CFSFU_QUALITY_KEY = 'telecord.cfsfu.quality';

const CFSFU_BITRATES = ['6', '12', '20'] as const;
export type CfSfuBitrateId = (typeof CFSFU_BITRATES)[number];

const CFSFU_QUALITIES = ['HD', 'FHD', 'QHD', 'UHD'] as const;
export type CfSfuQualityId = (typeof CFSFU_QUALITIES)[number];

/** Teto de bitrate do vídeo no Edge global. Escolhido na entrada, vale na sala. */
export function readCfSfuBitrate(): CfSfuBitrateId {
  try {
    const raw = window.localStorage.getItem(CFSFU_BITRATE_KEY);
    return CFSFU_BITRATES.includes(raw as CfSfuBitrateId) ? (raw as CfSfuBitrateId) : '12';
  } catch {
    return '12';
  }
}

export function writeCfSfuBitrate(id: CfSfuBitrateId): void {
  try {
    window.localStorage.setItem(CFSFU_BITRATE_KEY, id);
  } catch {
    // Storage indisponível: vale só para esta aba.
  }
}

/** Resolução alvo do compartilhamento de tela no Edge global. Padrão FHD. */
export function readCfSfuQuality(): CfSfuQualityId {
  try {
    const raw = window.localStorage.getItem(CFSFU_QUALITY_KEY);
    return CFSFU_QUALITIES.includes(raw as CfSfuQualityId) ? (raw as CfSfuQualityId) : 'FHD';
  } catch {
    return 'FHD';
  }
}

export function writeCfSfuQuality(id: CfSfuQualityId): void {
  try {
    window.localStorage.setItem(CFSFU_QUALITY_KEY, id);
  } catch {
    // Storage indisponível: vale só para esta aba.
  }
}

const PEER_ID_KEY = 'telecord.peerId';

/**
 * Identidade deste navegador na malha P2P.
 *
 * Estável entre recargas de propósito: se mudasse a cada carga, recarregar a
 * página deixaria a presença antiga pendurada por ~20 s e os outros tentariam
 * conectar num par que não existe mais. Com storage bloqueado, cai para um id
 * de sessão — pior, mas funciona.
 */
export function readPeerId(): string {
  const novo = (): string =>
    `p-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`.slice(0, 40);
  try {
    const atual = window.localStorage.getItem(PEER_ID_KEY);
    if (atual !== null && atual !== '') return atual;
    const gerado = novo();
    window.localStorage.setItem(PEER_ID_KEY, gerado);
    return gerado;
  } catch {
    return novo();
  }
}

const OVERLAY_KEY = 'telecord.overlay';

/**
 * Abrir o overlay sozinho ao entrar numa sala.
 *
 * DESLIGADO por padrão: abrir uma janela flutuante sem alguém pedir é
 * invasivo, e o navegador só permite a abertura a partir de um gesto — então
 * o automático só funciona depois do primeiro clique manual de qualquer
 * forma. A preferência serve para quem usa sempre não ter que reabrir.
 */
export function readOverlayAuto(): boolean {
  try {
    return window.localStorage.getItem(OVERLAY_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeOverlayAuto(enabled: boolean): void {
  try {
    window.localStorage.setItem(OVERLAY_KEY, enabled ? 'true' : 'false');
  } catch {
    // Storage indisponível: a escolha vale só para esta aba.
  }
}

const THEME_KEY = 'telecord.theme';

/**
 * Tema da interface.
 *
 * `escuro` é o padrão e é o `:root` do CSS — os demais só sobrescrevem
 * tokens. Valor desconhecido cai no padrão em vez de quebrar a tela.
 */
export type ThemeId = 'escuro' | 'claro' | 'direta' | 'livekit';

const THEMES: ThemeId[] = ['escuro', 'claro', 'direta', 'livekit'];

export function readTheme(): ThemeId {
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    return THEMES.includes(raw as ThemeId) ? (raw as ThemeId) : 'escuro';
  } catch {
    return 'escuro';
  }
}

export function writeTheme(id: ThemeId): void {
  try {
    window.localStorage.setItem(THEME_KEY, id);
  } catch {
    // Storage indisponível: o tema vale só para esta aba.
  }
}

/**
 * Aplica o tema na raiz do documento.
 *
 * `escuro` REMOVE o atributo em vez de gravá-lo: o padrão é o `:root`, e um
 * `data-theme="escuro"` sem bloco correspondente no CSS seria só ruído.
 */
export function applyTheme(id: ThemeId): void {
  const raiz = document.documentElement;
  if (id === 'escuro') {
    raiz.removeAttribute('data-theme');
    return;
  }
  raiz.setAttribute('data-theme', id);
}
