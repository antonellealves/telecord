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
  /** Marcou-se como ausente. Ver `AWAY_ATTRIBUTE`. */
  isAway: boolean;
}

/**
 * Chave do atributo de participante que marca quem está ausente.
 *
 * Vai como atributo do LiveKit, e não pelo canal de dados como o chat: o
 * servidor guarda o atributo e entrega junto com a lista de participantes, de
 * modo que quem entra depois já vê quem está ausente. Um aviso pelo canal de
 * dados só alcançaria quem estivesse na sala na hora, e obrigaria cada cliente
 * a reanunciar o próprio estado a cada pessoa que chegasse.
 */
export const AWAY_ATTRIBUTE = 'afk';

/** Único valor que conta como ausente; string vazia apaga a chave. */
export const AWAY_VALUE = '1';

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

// ---------------------------------------------------------------------------
// Autenticação (emenda pós-implementação — SPEC §2.4)
// ---------------------------------------------------------------------------

export const EMAIL_MAX_LENGTH = 320;
export const PASSWORD_MIN_LENGTH = 10;
/*
 * Teto porque a derivação processa a senha inteira: sem limite, um POST com um
 * megabyte de senha vira negação de serviço barata.
 */
export const PASSWORD_MAX_LENGTH = 200;
export const USERNAME_MAX_LENGTH = 32;

/**
 * Normalização de e-mail: só recorta e baixa a caixa.
 *
 * Nada de remover ponto ou sufixo `+tag` do Gmail: essas regras são de um
 * provedor só, e aplicá-las a todos faria `a.b@outradominio.com` e
 * `ab@outradominio.com` colidirem como se fossem a mesma pessoa — que é uma
 * tomada de conta silenciosa.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/*
 * Deliberadamente frouxo. Validar e-mail por expressão regular é briga
 * perdida — a gramática do RFC 5322 não cabe numa e toda versão "completa"
 * rejeita endereço legítimo. Quem diz se o endereço existe é o e-mail de
 * verificação; isto aqui só barra o que é obviamente errado.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function validateEmail(value: string): string | null {
  const email = normalizeEmail(value);
  if (email.length === 0) {
    return 'Digite um e-mail.';
  }
  if (email.length > EMAIL_MAX_LENGTH) {
    return `O e-mail pode ter no máximo ${EMAIL_MAX_LENGTH} caracteres.`;
  }
  if (!EMAIL_SHAPE.test(email)) {
    return 'Esse e-mail não parece válido.';
  }
  return null;
}

/**
 * Comprimento, e não composição.
 *
 * Exigir maiúscula, número e símbolo produz `Senha@123` — curta, previsível e
 * no topo de qualquer dicionário. Comprimento é a única regra que aumenta o
 * custo de quebrar de verdade.
 */
export function validatePassword(value: string): string | null {
  if (value.length < PASSWORD_MIN_LENGTH) {
    return `A senha precisa de pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  }
  if (value.length > PASSWORD_MAX_LENGTH) {
    return `A senha pode ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`;
  }
  return null;
}

export type AuthProviderName = 'password' | 'google';

/** Usuário autenticado, na forma que o cliente enxerga. */
export interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  role: 'USER' | 'ADMIN';
}

export interface AuthSessionResponse {
  user: AuthUser;
  accessToken: string;
  /** Segundos de vida do access token, para o cliente renovar antes de expirar. */
  expiresIn: number;
}

// ---------------------------------------------------------------------------
// Paginação por cursor (keyset)
// ---------------------------------------------------------------------------

/**
 * Uma página de resultados. `nextCursor` nulo significa fim.
 *
 * Keyset, e não `OFFSET`: com deslocamento, a página 200 obriga o banco a ler
 * e descartar 200 páginas, e uma linha inserida no meio da leitura desloca
 * tudo — a mesma linha aparece duas vezes ou some. O cursor carrega a posição
 * exata da última linha lida, então nenhum dos dois acontece.
 */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Máximo de itens por página, em qualquer listagem. */
export const PAGE_LIMIT_MAX = 100;
export const PAGE_LIMIT_DEFAULT = 50;

// ---------------------------------------------------------------------------
// Salas persistidas
// ---------------------------------------------------------------------------

export const ROOM_NAME_MAX_LENGTH = 48;
export const ROOM_DESCRIPTION_MAX_LENGTH = 200;

/**
 * Visibilidade da sala. NÃO existe "privada", e a ausência é deliberada.
 *
 * Quem emite o token de entrada é `api/token.ts`, uma função sem banco — e o
 * produto exige que uma queda do serviço de contas não impeça ninguém de
 * entrar numa sala. Uma sala privada de verdade precisa que a emissão do token
 * consulte a lista de membros, e as duas regras não cabem juntas sem uma
 * decisão que ainda não foi tomada.
 *
 * Marcar uma sala como privada aqui daria a aparência de controle sem o
 * controle: qualquer pessoa com a URL continuaria entrando. `UNLISTED` diz
 * exatamente o que faz — sai do diretório, continua alcançável pelo endereço.
 */
export type RoomVisibility = 'PUBLIC' | 'UNLISTED';

/** Papel dentro de uma sala. Governa administrar a sala, não entrar nela. */
export type RoomMemberRole = 'OWNER' | 'MOD' | 'MEMBER';

export interface RoomMemberView {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: RoomMemberRole;
  joinedAt: string;
}

export interface RoomSummary {
  slug: string;
  name: string;
  description: string | null;
  emoji: string | null;
  visibility: RoomVisibility;
  memberCount: number;
  soundCount: number;
  /** ISO 8601. */
  createdAt: string;
  /** Nunca nulo: uma sala recém-criada conta como ativa na criação. */
  lastActiveAt: string;
}

export interface RoomDetail extends RoomSummary {
  /** Papel de quem perguntou, ou null para anônimo e não-membro. */
  myRole: RoomMemberRole | null;
  members: RoomMemberView[];
}

export function validateRoomName(value: string): string | null {
  const name = normalizeDisplayName(value);
  if (name.length === 0) {
    return 'Digite um nome para a sala.';
  }
  if (name.length > ROOM_NAME_MAX_LENGTH) {
    return `O nome da sala pode ter no máximo ${ROOM_NAME_MAX_LENGTH} caracteres.`;
  }
  if (FORBIDDEN_NAME_CHARS.test(name)) {
    return 'O nome da sala tem caracteres não permitidos.';
  }
  return null;
}

export function validateRoomDescription(value: string): string | null {
  if (value.length > ROOM_DESCRIPTION_MAX_LENGTH) {
    return `A descrição pode ter no máximo ${ROOM_DESCRIPTION_MAX_LENGTH} caracteres.`;
  }
  if (FORBIDDEN_NAME_CHARS.test(value)) {
    return 'A descrição tem caracteres não permitidos.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sons enviados (soundboard por sala)
// ---------------------------------------------------------------------------

export const SOUND_LABEL_MAX_LENGTH = 32;

/**
 * Teto do arquivo enviado.
 *
 * Dois motivos para ser pequeno: os bytes moram numa linha do TiDB, que tem
 * limite de tamanho por transação; e a resposta de uma função da Vercel não
 * passa de 4,5 MB. Clipe de soundboard passa longe disso — o que estoura aqui
 * é upload de música inteira, que não é o caso de uso.
 */
export const MAX_SOUND_UPLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Formatos aceitos, pelo que o ARQUIVO diz ser — não pelo que o cliente
 * declara. O servidor fareja os bytes iniciais e ignora o `Content-Type`
 * enviado: aceitar a palavra do cliente é como um .exe vira "áudio".
 */
export type SoundMimeType =
  | 'audio/mpeg'
  | 'audio/ogg'
  | 'audio/wav'
  | 'audio/webm'
  | 'audio/mp4'
  | 'audio/flac'
  | 'audio/aac';

export interface RemoteSound {
  /** cuid — cabe no formato aceito por `parseRoomMessage`, e trafega igual. */
  id: string;
  label: string;
  /** Escolhido por quem enviou; nulo deixa o cliente sortear do catálogo. */
  emoji: string | null;
  /** Caminho do áudio na API, já pronto para `new Audio()`. */
  url: string;
  mimeType: SoundMimeType;
  byteSize: number;
  /** Informado pelo cliente no envio; só enfeite, pode ser nulo. */
  durationMs: number | null;
  /** Slug da sala, ou null para som global (instalado por um admin). */
  roomSlug: string | null;
  uploadedBy: { id: string; displayName: string } | null;
  createdAt: string;
  /** Se quem perguntou pode apagar este som. Decidido no servidor. */
  canDelete: boolean;
}

/** Deriva o rótulo do nome do arquivo, como o catálogo local já faz. */
export function soundLabelFromFilename(filename: string): string {
  const file = filename.slice(filename.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  const label = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return label.slice(0, SOUND_LABEL_MAX_LENGTH);
}

export function validateSoundLabel(value: string): string | null {
  const label = normalizeDisplayName(value);
  if (label.length === 0) {
    return 'O som precisa de um nome.';
  }
  if (label.length > SOUND_LABEL_MAX_LENGTH) {
    return `O nome do som pode ter no máximo ${SOUND_LABEL_MAX_LENGTH} caracteres.`;
  }
  if (FORBIDDEN_NAME_CHARS.test(label)) {
    return 'O nome do som tem caracteres não permitidos.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Registro de eventos (painel de administração)
// ---------------------------------------------------------------------------

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export const LOG_LEVELS: readonly LogLevel[] = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

export interface SystemLogEntry {
  id: string;
  level: LogLevel;
  /** Módulo que escreveu: `auth`, `rooms`, `sounds`, `livekit`. */
  scope: string;
  /** Nome curto e estável do acontecimento: `login.ok`, `sound.upload`. */
  event: string;
  message: string;
  userId: string | null;
  userLabel: string | null;
  roomSlug: string | null;
  ip: string | null;
  /** Campos extras, já passados pelo filtro que remove credencial. */
  context: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * Trilha de auditoria: quem fez o quê, com o antes e o depois.
 *
 * Separada do `SystemLog` porque as duas têm retenções diferentes. O log
 * técnico expira sozinho em 30 dias; a auditoria não expira — ela existe
 * justamente para responder perguntas sobre o passado.
 */
export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorLabel: string;
  action: string;
  targetType: string;
  targetId: string;
  summary: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Painel: indicadores e séries
// ---------------------------------------------------------------------------

/** Um ponto de série diária. `date` é `YYYY-MM-DD` em UTC. */
export interface MetricPoint {
  date: string;
  value: number;
}

/**
 * Um indicador com comparação contra o período anterior de mesmo tamanho.
 * `previous` nulo quando não faz sentido comparar (totais acumulados).
 */
export interface Kpi {
  value: number;
  previous: number | null;
}

export interface DashboardMetrics {
  /** Dias cobertos pelo recorte, contados para trás a partir de hoje (UTC). */
  days: number;
  generatedAt: string;

  totalUsers: Kpi;
  newUsers: Kpi;
  activeUsers: Kpi;
  /** Entradas em sala observadas pelo webhook do LiveKit. */
  sessions: Kpi;
  voiceMinutes: Kpi;
  roomsCreated: Kpi;
  soundsUploaded: Kpi;
  errors: Kpi;

  newUsersSeries: MetricPoint[];
  sessionsSeries: MetricPoint[];
  voiceMinutesSeries: MetricPoint[];
  errorsSeries: MetricPoint[];

  topRooms: { slug: string; sessions: number; minutes: number }[];
  levelBreakdown: { level: LogLevel; count: number }[];
  /**
   * `false` quando nenhuma sessão foi registrada no período — quase sempre
   * significa webhook do LiveKit não configurado, e o painel precisa dizer
   * isso em vez de mostrar zero como se fosse a verdade.
   */
  hasSessionData: boolean;
}

export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  username: string;
  role: 'USER' | 'ADMIN';
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED';
  emailVerified: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}
