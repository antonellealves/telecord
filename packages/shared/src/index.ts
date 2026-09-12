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
  /** Slug do canal ao qual esta sala pertence, ou null se for avulsa. É o
   * que permite a `RoomShell` desenhar a navegação entre salas do mesmo canal
   * sem uma segunda ida ao banco. */
  channelSlug: string | null;
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
// Canais — agrupadores de salas transitáveis
// ---------------------------------------------------------------------------

export const CHANNEL_NAME_MAX_LENGTH = 48;
export const CHANNEL_DESCRIPTION_MAX_LENGTH = 200;
/** Quantas salas cabem num canal antes da UI virar uma lista impraticável. */
export const CHANNEL_ROOM_LIMIT = 60;

/** Papel dentro de um canal. Governa criar/renomear salas do canal e mexer
 * nos membros do canal — não o papel de uma sala específica (`RoomMemberRole`),
 * que continua independente: promover alguém no canal não muda o papel dela
 * em nenhuma sala existente dentro dele. */
export type ChannelMemberRole = 'OWNER' | 'MOD' | 'MEMBER';

export interface ChannelMemberView {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  role: ChannelMemberRole;
  joinedAt: string;
}

/**
 * Uma sala como aparece dentro da lista de um canal — o suficiente para
 * desenhar o item de navegação (nome, emoji, quantas pessoas) sem carregar o
 * `RoomDetail` inteiro (membros, contagem de sons) para cada uma das salas do
 * canal de uma vez só.
 */
export interface ChannelRoomEntry {
  slug: string;
  name: string;
  emoji: string | null;
  position: number;
  /** Contagem de participantes é derivada do SFU, não do banco — fica de fora
   * daqui e é responsabilidade do cliente casar com `GET /api/rooms` (a
   * função das salas ao vivo), do mesmo jeito que a tela inicial já faz com o
   * diretório de salas soltas. */
}

export interface ChannelSummary {
  slug: string;
  name: string;
  description: string | null;
  emoji: string | null;
  visibility: RoomVisibility;
  memberCount: number;
  roomCount: number;
  /** ISO 8601. */
  createdAt: string;
}

export interface ChannelDetail extends ChannelSummary {
  /** Papel de quem perguntou, ou null para anônimo e não-membro. */
  myRole: ChannelMemberRole | null;
  members: ChannelMemberView[];
  /** Em ordem de exibição (`position`, depois `id` para desempate). */
  rooms: ChannelRoomEntry[];
}

export function validateChannelName(value: string): string | null {
  const name = normalizeDisplayName(value);
  if (name.length === 0) {
    return 'Digite um nome para o canal.';
  }
  if (name.length > CHANNEL_NAME_MAX_LENGTH) {
    return `O nome do canal pode ter no máximo ${CHANNEL_NAME_MAX_LENGTH} caracteres.`;
  }
  if (FORBIDDEN_NAME_CHARS.test(name)) {
    return 'O nome do canal tem caracteres não permitidos.';
  }
  return null;
}

export function validateChannelDescription(value: string): string | null {
  if (value.length > CHANNEL_DESCRIPTION_MAX_LENGTH) {
    return `A descrição pode ter no máximo ${CHANNEL_DESCRIPTION_MAX_LENGTH} caracteres.`;
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

// ---------------------------------------------------------------------------
// Moderação ao vivo e as demais tabelas no painel
// ---------------------------------------------------------------------------

/** Sala com gente dentro AGORA, lida do SFU e não do banco. */
export interface LiveRoom {
  slug: string;
  participants: number;
  createdAt: string;
}

export interface LiveTrack {
  sid: string;
  source: string;
  muted: boolean;
}

export interface LiveParticipant {
  identity: string;
  displayName: string;
  joinedAt: string;
  /**
   * Entrou sem conta. Em quem é anônimo só dá para agir na SALA (mutar, mover,
   * remover); suspender e banir agem na conta, que essa pessoa não tem.
   */
  isAnonymous: boolean;
  tracks: LiveTrack[];
}

/** Linha de `Room` como o painel lê — a ficha, não a sala viva. */
export interface AdminRoomRow {
  id: string;
  slug: string;
  name: string;
  visibility: RoomVisibility;
  ownerLabel: string | null;
  channelSlug: string | null;
  members: number;
  sounds: number;
  createdAt: string;
  lastActiveAt: string;
}

export interface AdminChannelRow {
  id: string;
  slug: string;
  name: string;
  visibility: RoomVisibility;
  ownerLabel: string | null;
  rooms: number;
  members: number;
  createdAt: string;
}

export interface AdminSoundRow {
  id: string;
  label: string;
  emoji: string | null;
  roomSlug: string | null;
  uploadedByLabel: string | null;
  byteSize: number;
  mimeType: string;
  createdAt: string;
}

export interface AdminSessionRow {
  id: string;
  roomSlug: string;
  participantName: string;
  identity: string;
  joinedAt: string;
  leftAt: string | null;
  durationSeconds: number | null;
}

/** Sessão de login viva: um `RefreshToken` não expirado nem revogado. */
export interface AdminSessionTokenRow {
  id: string;
  userLabel: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
}

// ---------------------------------------------------------------------------
// Modo P2P — o segundo paradigma de transmissão
//
// No modo LiveKit, um SFU recebe de todos e reenvia para todos. No modo P2P,
// cada navegador fala DIRETO com cada outro, e o servidor só apresenta os dois.
// A troca abaixo é o aperto de mão; depois dele, nenhum byte de mídia passa
// pelo telecord.
// ---------------------------------------------------------------------------

/**
 * Qual pilha de transmissão a sala está usando.
 *
 * `cfsfu` é o Cloudflare Realtime SFU — a terceira opção, "Cloudflare": um SFU
 * de borda que NÃO recodifica a mídia (passthrough), então a qualidade final é
 * a que o navegador de quem compartilha conseguir codificar. Existe para
 * compartilhamento de tela em alta resolução com latência baixa e escala melhor
 * que a malha P2P.
 */
export type TransportMode = 'livekit' | 'p2p' | 'cfsfu';

export const TRANSPORT_MODES: TransportMode[] = ['livekit', 'p2p', 'cfsfu'];

export interface PeerInfo {
  peerId: string;
  displayName: string;
  isAnonymous: boolean;
  joinedAt: string;
  /**
   * O que este par publicou no SFU cfsfu, quando a sala está nesse modo. É como
   * os outros descobrem qual `sessionId`/`trackName` puxar — o roster do
   * heartbeat carrega o anúncio, sem precisar de um segundo canal de sinal.
   * `null`/ausente nos modos LiveKit e P2P.
   */
  cfsfu?: CfSfuAnnounce | null;
}

export interface PeerRoster {
  peers: PeerInfo[];
}

/** `offer` e `answer` carregam SDP; `ice` carrega um candidato. */
export type PeerSignalKind = 'offer' | 'answer' | 'ice';

export interface PeerEnvelope {
  fromPeer: string;
  kind: PeerSignalKind;
  /** Opaco para o servidor: ele carrega, não interpreta. */
  payload: string;
}

export interface PeerInbox {
  signals: PeerEnvelope[];
}

/**
 * Um servidor de gelo (ICE) para o modo direto: STUN ou TURN.
 *
 * Espelha o `RTCIceServer` do navegador de propósito — o cliente repassa o que
 * chega direto para o `RTCPeerConnection`, sem tradução. STUN só leva `urls`;
 * TURN leva também `username` e `credential`, que quando temporários (padrão
 * coturn) vêm assinados pelo servidor e expiram.
 */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Configuração de ICE entregue por `GET /api/ice`.
 *
 * Vem do servidor, e não fixada no bundle, por dois motivos: dá para acrescentar
 * ou trocar um TURN sem publicar o front de novo, e credencial de TURN
 * temporária NÃO pode viver em JavaScript público — ela é gerada por requisição
 * e válida só por `ttlSeconds`. Sem TURN configurado, vem só o STUN, que já
 * resolve a maioria das redes.
 */
export interface IceConfig {
  iceServers: IceServerConfig[];
  /** Por quanto tempo o cliente pode reusar esta lista antes de buscar de novo. */
  ttlSeconds: number;
}

// ---------------------------------------------------------------------------
// Cloudflare Realtime SFU (transporte 'cfsfu' — "Cloudflare")
//
// O SFU da Cloudflare é pub/sub de Sessions e Tracks, SEM conceito de sala: o
// roster e a descoberta de tracks são do telecord (carregados pelo heartbeat).
// O App Secret vive só no backend; o cliente conversa com o SFU através do
// proxy /api/cfsfu/*, que assina as chamadas. Os tipos abaixo descrevem o corpo
// desse proxy — que espelha a API HTTPS do SFU — e são validados na borda.
// ---------------------------------------------------------------------------

/** SDP trocado com o SFU. Mesma forma de `RTCSessionDescriptionInit`. */
export interface CfSdp {
  type: 'offer' | 'answer';
  sdp: string;
}

/** Uma track ao pedir push (local) ou pull (remoto) ao SFU. */
export type CfTrackRequest =
  | { location: 'local'; mid: string; trackName: string }
  | { location: 'remote'; sessionId: string; trackName: string };

/** Track como o SFU a devolve. */
export interface CfTrackResult {
  mid?: string;
  trackName?: string;
  sessionId?: string;
  errorCode?: string;
  errorDescription?: string;
}

/** Resposta de `POST /sessions/new`. */
export interface CfSessionResult {
  sessionId: string;
  errorCode?: string;
  errorDescription?: string;
}

/** Corpo aceito pelo proxy `POST /api/cfsfu/sessions/:id/tracks`. */
export interface CfTracksBody {
  sessionDescription?: CfSdp;
  tracks: CfTrackRequest[];
}

/** Resposta de `tracks/new`. */
export interface CfTracksResult {
  requiresImmediateRenegotiation: boolean;
  sessionDescription?: CfSdp;
  tracks: CfTrackResult[];
  errorCode?: string;
  errorDescription?: string;
}

/** Corpo de `PUT /renegotiate`. */
export interface CfRenegotiateBody {
  sessionDescription: CfSdp;
}

/** Resposta de `renegotiate` e `tracks/close` (vazia em sucesso). */
export interface CfSimpleResult {
  errorCode?: string;
  errorDescription?: string;
}

/** Corpo de `PUT /tracks/close`. */
export interface CfCloseBody {
  tracks: { mid: string }[];
  sessionDescription: CfSdp;
  force: boolean;
}

/** Anúncio do que um par publicou no SFU, carregado pelo roster. */
export interface CfSfuAnnounce {
  sessionId: string;
  tracks: CfSfuPublishedTrack[];
}

export interface CfSfuPublishedTrack {
  kind: 'audio' | 'video';
  trackName: string;
  /** Rótulo para a UI: 'screen-video', 'mic-audio', 'system-audio'. */
  label: string;
}

/** Consumo estimado de egress do mês, para o aviso e o bloqueio na UI. */
export interface CfSfuUsage {
  monthlyLimitGb: number;
  usedGb: number;
  /** 0..1. A UI avisa em 0,8 e bloqueia a criação em 1. */
  fraction: number;
  blocked: boolean;
}

/** Config pública do transporte cfsfu, servida por `GET /api/cfsfu/config`. */
export interface CfSfuClientConfig {
  enabled: boolean;
  iceServers: IceServerConfig[];
  usage: CfSfuUsage;
}

/**
 * Métricas de qualidade lidas de `RTCPeerConnection.getStats()`.
 *
 * Tipadas de propósito: `getStats` devolve um mapa de formas variadas, e o
 * lugar de lidar com isso é a borda que extrai estes campos — daqui para dentro
 * tudo é número ou nulo, nunca `any`.
 */
export interface QualityMetrics {
  codec: string | null;
  width: number | null;
  height: number | null;
  framesPerSecond: number | null;
  bitrateKbps: number | null;
  packetsLost: number;
  jitterMs: number | null;
  roundTripTimeMs: number | null;
  framesDropped: number | null;
  framesDecoded: number | null;
  availableIncomingBitrateKbps: number | null;
  availableOutgoingBitrateKbps: number | null;
}

/**
 * A partir de quantas pessoas o modo direto começa a doer.
 *
 * NÃO é um teto: a sala aceita quem chegar. É o ponto em que a conta da malha
 * completa deixa de ser confortável e a interface passa a avisar.
 *
 * A conta: cada par mantém uma conexão com cada outro, então as conexões
 * crescem com o QUADRADO das pessoas, e cada navegador codifica o próprio
 * vídeo uma vez PARA CADA par. Com 6 são 15 conexões e 5 codificações por
 * máquina; com 10, são 45 e 9. Quem tem máquina e banda para isso deve poder
 * tentar — o aviso existe para a lentidão não virar surpresa, e a saída
 * (trocar para o servidor de mídia) fica a um clique.
 */
export const P2P_COMFORT_PEERS = 6;

/**
 * Posição de um quadro na tela, em FRAÇÃO da área (0..1).
 *
 * Fração e não pixel: quem arruma no monitor grande e abre no notebook
 * encontra a mesma arrumação proporcional, em vez de quadros fora da tela.
 */
export interface TilePosition {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `peerId` → onde o quadro daquele par fica NA MINHA tela. */
export type TileLayout = Record<string, TilePosition>;

/** Limites de sanidade; o servidor recusa fora disso. */
export const TILE_MIN_SIZE = 0.08;
export const MAX_TILES_SAVED = 24;

export function isTilePosition(value: unknown): value is TilePosition {
  if (typeof value !== 'object' || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    ['x', 'y', 'w', 'h'].every((k) => typeof t[k] === 'number' && Number.isFinite(t[k] as number)) &&
    (t.w as number) >= TILE_MIN_SIZE &&
    (t.h as number) >= TILE_MIN_SIZE
  );
}
