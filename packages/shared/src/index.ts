/**
 * Contrato entre o navegador e a função serverless, e os tipos do estado de
 * sala derivado do LiveKit. Consumido pelos dois lados: `apps/web` (via alias
 * do Vite para o source) e `api/token.ts` (via `dist/`, gerado no build).
 *
 * Nada aqui depende de DOM nem de Node: é código de contrato puro.
 */

// ---------------------------------------------------------------------------
// Limites e formatos (SPEC §2.1)
// ---------------------------------------------------------------------------

export const ROOM_ID_MIN_LENGTH = 3;
export const ROOM_ID_MAX_LENGTH = 64;
export const DISPLAY_NAME_MAX_LENGTH = 32;

/** Corpo máximo aceito em POST /api/token. */
export const MAX_TOKEN_REQUEST_BYTES = 4096;

/** TTL do JWT. Governa só o join; ver SPEC §2.2. */
export const TOKEN_TTL_SECONDS = 600;

/** Slug: minúsculas, dígitos e hífens simples entre segmentos. */
export const ROOM_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Caracteres de controle e de formatação, proibidos no nome de exibição. */
const FORBIDDEN_NAME_CHARS = /[\p{Cc}\p{Cf}]/u;

// ---------------------------------------------------------------------------
// Contrato de POST /api/token
// ---------------------------------------------------------------------------

export interface TokenRequest {
  roomId: string;
  displayName: string;
}

export interface TokenSuccessResponse {
  /** JWT do LiveKit. */
  token: string;
  /** Identity única gerada pelo servidor. */
  identity: string;
  /** roomId normalizado — é nele que o token é válido. */
  roomId: string;
  /** displayName normalizado. */
  displayName: string;
  expiresInSeconds: number;
}

export type TokenErrorCode =
  | 'INVALID_JSON'
  | 'MISSING_FIELD'
  | 'INVALID_ROOM_ID'
  | 'INVALID_DISPLAY_NAME'
  | 'METHOD_NOT_ALLOWED'
  | 'PAYLOAD_TOO_LARGE'
  | 'SERVER_MISCONFIGURED'
  | 'TOKEN_SIGN_FAILED';

export interface TokenErrorResponse {
  error: {
    code: TokenErrorCode;
    message: string;
  };
}

export type TokenResponse = TokenSuccessResponse | TokenErrorResponse;

export function isTokenErrorResponse(value: TokenResponse): value is TokenErrorResponse {
  return 'error' in value;
}

// ---------------------------------------------------------------------------
// Normalização e validação (usadas pelo cliente e pelo servidor)
// ---------------------------------------------------------------------------

export function normalizeRoomId(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/**
 * Converte texto livre em slug válido. É responsabilidade do CLIENTE chamar
 * isto antes de enviar: o servidor rejeita, não conserta (SPEC §2.1).
 * Devolve string vazia quando não sobra nada aproveitável.
 */
export function slugifyRoomId(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ROOM_ID_MAX_LENGTH)
    .replace(/-+$/g, '');
}

export type ValidationErrorCode = Extract<
  TokenErrorCode,
  'INVALID_JSON' | 'MISSING_FIELD' | 'INVALID_ROOM_ID' | 'INVALID_DISPLAY_NAME'
>;

export type ValidationResult =
  | { ok: true; value: TokenRequest }
  | { ok: false; code: ValidationErrorCode; message: string };

/** Devolve a mensagem de erro, ou `null` quando o valor é válido. */
export function validateRoomId(value: string): string | null {
  const roomId = normalizeRoomId(value);
  if (roomId.length < ROOM_ID_MIN_LENGTH || roomId.length > ROOM_ID_MAX_LENGTH) {
    return `O nome da sala precisa ter de ${ROOM_ID_MIN_LENGTH} a ${ROOM_ID_MAX_LENGTH} caracteres.`;
  }
  if (!ROOM_ID_PATTERN.test(roomId)) {
    return 'Use apenas letras minúsculas, números e hífens (ex.: reuniao-do-time).';
  }
  return null;
}

export function validateDisplayName(value: string): string | null {
  const displayName = normalizeDisplayName(value);
  if (displayName.length === 0) {
    return 'Digite um nome de exibição.';
  }
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    return `O nome de exibição pode ter no máximo ${DISPLAY_NAME_MAX_LENGTH} caracteres.`;
  }
  if (FORBIDDEN_NAME_CHARS.test(displayName)) {
    return 'O nome de exibição tem caracteres não permitidos.';
  }
  return null;
}

/**
 * Valida o corpo de POST /api/token. Ordem importa: a primeira falha corta.
 */
export function validateTokenRequest(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_JSON', message: 'O corpo precisa ser um objeto JSON.' };
  }

  const { roomId, displayName } = input as { roomId?: unknown; displayName?: unknown };

  if (roomId === undefined || displayName === undefined) {
    return { ok: false, code: 'MISSING_FIELD', message: 'roomId e displayName são obrigatórios.' };
  }
  if (typeof roomId !== 'string') {
    return { ok: false, code: 'INVALID_ROOM_ID', message: 'roomId precisa ser uma string.' };
  }
  if (typeof displayName !== 'string') {
    return {
      ok: false,
      code: 'INVALID_DISPLAY_NAME',
      message: 'displayName precisa ser uma string.',
    };
  }

  const roomIdError = validateRoomId(roomId);
  if (roomIdError !== null) {
    return { ok: false, code: 'INVALID_ROOM_ID', message: roomIdError };
  }

  const displayNameError = validateDisplayName(displayName);
  if (displayNameError !== null) {
    return { ok: false, code: 'INVALID_DISPLAY_NAME', message: displayNameError };
  }

  return {
    ok: true,
    value: {
      roomId: normalizeRoomId(roomId),
      displayName: normalizeDisplayName(displayName),
    },
  };
}

// ---------------------------------------------------------------------------
// Estado de sala derivado do SFU (SPEC §3). Nada disso é persistido.
// ---------------------------------------------------------------------------

/** Estados de conexão que a UI precisa distinguir (SPEC §5). */
export type ConnectionStatus =
  | 'idle'
  | 'requesting-token'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error';

/** Projeção de um participante, derivada do `Room` a cada evento. */
export interface ParticipantView {
  identity: string;
  displayName: string;
  isLocal: boolean;
  isSpeaking: boolean;
  isMicrophoneEnabled: boolean;
  isSharingScreen: boolean;
}

/** Quem detém a tela, quando alguém detém. */
export interface ScreenShareOwner {
  identity: string;
  displayName: string;
  isLocal: boolean;
  trackSid: string;
}

// ---------------------------------------------------------------------------
// Mensagens pelo canal de dados do LiveKit (SPEC §6.7)
// ---------------------------------------------------------------------------

export const MAX_CHAT_LENGTH = 400;

/** Limite de mensagens guardadas em memória por cliente. */
export const CHAT_HISTORY_LIMIT = 200;

export interface ChatMessage {
  type: 'chat';
  /** Único por mensagem; usado como key e para deduplicar. */
  id: string;
  body: string;
  sentAt: number;
}

export interface SoundCue {
  type: 'sound';
  id: string;
  /** Id do som no catálogo montado a partir de apps/web/src/assets/sons. */
  soundId: string;
  sentAt: number;
}

/**
 * Pedido de parar o som que está tocando.
 *
 * Carrega o `soundId` de propósito: sem ele, um pedido que chegasse atrasado
 * cortaria o som seguinte, que já tinha começado. Cada cliente só para se o
 * que estiver tocando ali for esse mesmo som.
 */
export interface SoundStop {
  type: 'sound-stop';
  id: string;
  soundId: string;
  sentAt: number;
}

export type RoomMessage = ChatMessage | SoundCue | SoundStop;

/** Formato do id de som, gerado assim pelo catálogo e validado aqui. */
const SOUND_ID_PATTERN = /^[a-z0-9-]{1,32}$/;

/**
 * Valida uma mensagem recebida pelo canal de dados.
 *
 * O canal é aberto a qualquer participante, e participante é só quem tem o
 * token — ou seja, conteúdo daqui é entrada não confiável e passa pelas mesmas
 * regras de tamanho e formato que a API aplica.
 */
export function parseRoomMessage(raw: unknown): RoomMessage | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  // Forma solta de propósito: `Partial<ChatMessage & SoundCue>` faria o campo
  // `type` intersectar 'chat' com 'sound' e virar `never`, o que apaga todos os
  // outros campos junto.
  const value = raw as {
    type?: unknown;
    id?: unknown;
    sentAt?: unknown;
    body?: unknown;
    soundId?: unknown;
  };
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 64) {
    return null;
  }
  if (typeof value.sentAt !== 'number' || !Number.isFinite(value.sentAt)) {
    return null;
  }

  if (value.type === 'chat') {
    if (typeof value.body !== 'string') return null;
    const body = value.body.trim();
    if (body.length === 0 || body.length > MAX_CHAT_LENGTH) return null;
    return { type: 'chat', id: value.id, body, sentAt: value.sentAt };
  }

  if (value.type === 'sound' || value.type === 'sound-stop') {
    if (typeof value.soundId !== 'string' || !SOUND_ID_PATTERN.test(value.soundId)) {
      return null;
    }
    const soundId = value.soundId;
    return value.type === 'sound'
      ? { type: 'sound', id: value.id, soundId, sentAt: value.sentAt }
      : { type: 'sound-stop', id: value.id, soundId, sentAt: value.sentAt };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Host do LiveKit
// ---------------------------------------------------------------------------

/**
 * Host do projeto LiveKit, sem esquema.
 *
 * Fica aqui porque os dois lados precisam dele em formatos diferentes — o
 * navegador conecta em `wss://`, a API de servidor fala `https://` — e manter
 * duas cópias do mesmo host é como elas divergem. É um endereço público: o
 * navegador o expõe de qualquer forma.
 */
export const LIVEKIT_HOST = 'telecord-rjk64f88.livekit.cloud';

// ---------------------------------------------------------------------------
// Contrato de GET /api/rooms
// ---------------------------------------------------------------------------

export interface ActiveRoom {
  roomId: string;
  participants: number;
  /** Epoch em milissegundos. */
  startedAt: number;
}

export interface RoomsSuccessResponse {
  rooms: ActiveRoom[];
}

export type RoomsErrorCode = 'METHOD_NOT_ALLOWED' | 'SERVER_MISCONFIGURED' | 'UPSTREAM_UNAVAILABLE';

export interface RoomsErrorResponse {
  error: {
    code: RoomsErrorCode;
    message: string;
  };
}

export type RoomsResponse = RoomsSuccessResponse | RoomsErrorResponse;

export function isRoomsErrorResponse(value: RoomsResponse): value is RoomsErrorResponse {
  return 'error' in value;
}
