/**
 * Gamificação: missões, conquistas (medalhas), XP e nível.
 *
 * ## Por que um store fora do React
 *
 * Os eventos que valem pontos nascem espalhados — abrir o microfone na barra,
 * mandar mensagem no chat, entrar numa sala, trocar de tema — e viriam de
 * componentes que não têm parentesco na árvore. Passar um `track` por props até
 * cada um deles seria fio demais. Um store singleton, assinado por
 * `useSyncExternalStore`, deixa QUALQUER canto do app anotar um progresso com
 * uma chamada de função, e a interface reage sozinha.
 *
 * Nada disso sobe para o servidor: é conquista LOCAL, deste navegador, no mesmo
 * espírito do resto do produto (SPEC §3 — o localStorage guarda preferência, não
 * identidade). Storage bloqueado degrada para memória da aba, nunca derruba.
 */

export type Rarity = 'comum' | 'raro' | 'epico' | 'lendario';

export type MissionCategory = 'inicio' | 'grind' | 'social' | 'descoberta' | 'segredo';

/** De onde a missão lê seu progresso: um contador ou o tamanho de um conjunto. */
type Progress = { counter: string } | { set: string };

export interface Mission {
  id: string;
  title: string;
  desc: string;
  /** Emoji que representa a missão — a "arte" barata de cada card. */
  emoji: string;
  goal: number;
  progress: Progress;
  xp: number;
  rarity: Rarity;
  category: MissionCategory;
  /** Escondida até ser concluída: o texto vira "???" enquanto isso. */
  hidden?: boolean;
  /** Dica de como completar, revelada quando faz sentido mostrá-la. */
  tip?: string;
}

export interface Rank {
  name: string;
  emoji: string;
  /** XP mínimo para alcançar este posto. */
  xp: number;
  /** Cor do anel/brilho da medalha. */
  color: string;
}

// ---------------------------------------------------------------------------
// Catálogo de postos (medalhas de nível)
// ---------------------------------------------------------------------------

/*
 * Nomes de medalha inspirados no Dota — o app é "para a galera do dota teleton",
 * então o vocabulário de rank já é dos habitantes. Os limiares sobem em passos
 * cada vez maiores: os primeiros vêm rápido para dar tração, os últimos custam.
 */
export const RANKS: Rank[] = [
  { name: 'Arauto', emoji: '🔰', xp: 0, color: '#9aa4b2' },
  { name: 'Guardião', emoji: '🛡️', xp: 90, color: '#7ec8a8' },
  { name: 'Cruzado', emoji: '⚔️', xp: 210, color: '#6fb0e6' },
  { name: 'Arconte', emoji: '🏹', xp: 370, color: '#8f7ce0' },
  { name: 'Lenda', emoji: '🎖️', xp: 560, color: '#e0a84e' },
  { name: 'Ancião', emoji: '🏛️', xp: 780, color: '#e07a5f' },
  { name: 'Divino', emoji: '💠', xp: 1030, color: '#d06fd0' },
  { name: 'Imortal', emoji: '👑', xp: 1300, color: '#ff5d5d' },
];

// ---------------------------------------------------------------------------
// Catálogo de missões
// ---------------------------------------------------------------------------

export const CATEGORY_LABEL: Record<MissionCategory, string> = {
  inicio: 'Primeiros passos',
  grind: 'Rotina',
  social: 'Convívio',
  descoberta: 'Descoberta',
  segredo: 'Segredos',
};

export const CATEGORY_ORDER: MissionCategory[] = [
  'inicio',
  'grind',
  'social',
  'descoberta',
  'segredo',
];

export const MISSIONS: Mission[] = [
  // --- Primeiros passos: uma ação de cada, para conhecer o produto ----------
  {
    id: 'first-call',
    title: 'Primeiro toque',
    desc: 'Entre em uma sala.',
    emoji: '🚪',
    goal: 1,
    progress: { counter: 'joins' },
    xp: 20,
    rarity: 'comum',
    category: 'inicio',
    tip: 'Crie ou entre em qualquer sala pela tela inicial.',
  },
  {
    id: 'mic-check',
    title: 'Teste de som',
    desc: 'Abra seu microfone.',
    emoji: '🎙️',
    goal: 1,
    progress: { counter: 'mics' },
    xp: 20,
    rarity: 'comum',
    category: 'inicio',
    tip: 'Clique no microfone na barra de controles.',
  },
  {
    id: 'show-face',
    title: 'Mostra a cara',
    desc: 'Ligue a câmera.',
    emoji: '📷',
    goal: 1,
    progress: { counter: 'cameras' },
    xp: 20,
    rarity: 'comum',
    category: 'inicio',
  },
  {
    id: 'share-build',
    title: 'Compartilha a build',
    desc: 'Compartilhe sua tela.',
    emoji: '🖥️',
    goal: 1,
    progress: { counter: 'screens' },
    xp: 25,
    rarity: 'comum',
    category: 'inicio',
  },
  {
    id: 'say-something',
    title: 'Digita aí',
    desc: 'Mande a primeira mensagem no chat.',
    emoji: '💬',
    goal: 1,
    progress: { counter: 'chats' },
    xp: 20,
    rarity: 'comum',
    category: 'inicio',
  },
  {
    id: 'first-drop',
    title: 'Primeiro drop',
    desc: 'Toque um som do soundboard.',
    emoji: '🔊',
    goal: 1,
    progress: { counter: 'sounds' },
    xp: 20,
    rarity: 'comum',
    category: 'inicio',
  },

  // --- Rotina: repetição, o "grind" ----------------------------------------
  {
    id: 'marathon',
    title: 'Maratonista',
    desc: 'Some 60 minutos dentro de salas.',
    emoji: '⏱️',
    goal: 60,
    progress: { counter: 'minutes' },
    xp: 100,
    rarity: 'raro',
    category: 'grind',
    tip: 'O tempo soma entre todas as suas sessões.',
  },
  {
    id: 'chatterbox',
    title: 'Tagarela',
    desc: 'Mande 50 mensagens no chat.',
    emoji: '⌨️',
    goal: 50,
    progress: { counter: 'chats' },
    xp: 90,
    rarity: 'raro',
    category: 'grind',
  },
  {
    id: 'setlist',
    title: 'Set list',
    desc: 'Toque 30 sons no total.',
    emoji: '🎛️',
    goal: 30,
    progress: { counter: 'sounds' },
    xp: 80,
    rarity: 'raro',
    category: 'grind',
  },
  {
    id: 'presenter',
    title: 'Palestrante',
    desc: 'Compartilhe a tela 10 vezes.',
    emoji: '📽️',
    goal: 10,
    progress: { counter: 'screens' },
    xp: 90,
    rarity: 'raro',
    category: 'grind',
  },
  {
    id: 'regular',
    title: 'Freguês da casa',
    desc: 'Entre em salas 25 vezes.',
    emoji: '🔁',
    goal: 25,
    progress: { counter: 'joins' },
    xp: 90,
    rarity: 'raro',
    category: 'grind',
  },

  // --- Convívio: precisa de gente por perto --------------------------------
  {
    id: 'full-house',
    title: 'Sala cheia',
    desc: 'Esteja numa sala com 5 pessoas ao mesmo tempo.',
    emoji: '👥',
    goal: 5,
    progress: { counter: 'peak' },
    xp: 70,
    rarity: 'epico',
    category: 'social',
    tip: 'Chame a galera para o mesmo canal.',
  },
  {
    id: 'host',
    title: 'Anfitrião',
    desc: 'Crie uma sala nova com nome aleatório.',
    emoji: '🏠',
    goal: 1,
    progress: { counter: 'roomsCreated' },
    xp: 40,
    rarity: 'comum',
    category: 'social',
    tip: 'Deixe o nome da sala em branco ao entrar.',
  },
  {
    id: 'explorer',
    title: 'Explorador',
    desc: 'Visite 8 salas diferentes.',
    emoji: '🧭',
    goal: 8,
    progress: { set: 'rooms' },
    xp: 80,
    rarity: 'raro',
    category: 'social',
  },

  // --- Descoberta: cantos do produto que passam batido ---------------------
  {
    id: 'chameleon',
    title: 'Camaleão',
    desc: 'Experimente os 4 temas.',
    emoji: '🎨',
    goal: 4,
    progress: { set: 'themes' },
    xp: 80,
    rarity: 'raro',
    category: 'descoberta',
    tip: 'Troque o tema em configurações.',
  },
  {
    id: 'magic-window',
    title: 'Janela mágica',
    desc: 'Abra o overlay de participantes.',
    emoji: '🪟',
    goal: 1,
    progress: { counter: 'overlays' },
    xp: 40,
    rarity: 'comum',
    category: 'descoberta',
  },
  {
    id: 'both-worlds',
    title: 'Os dois mundos',
    desc: 'Use o modo LiveKit e o modo direto (P2P).',
    emoji: '🌐',
    goal: 2,
    progress: { set: 'transports' },
    xp: 60,
    rarity: 'epico',
    category: 'descoberta',
    tip: 'A escolha do transporte fica na tela de entrada.',
  },

  // --- Segredos: escondidas até caírem no colo -----------------------------
  {
    id: 'night-owl',
    title: 'Coruja',
    desc: 'Entre numa sala entre meia-noite e 5h.',
    emoji: '🦉',
    goal: 1,
    progress: { counter: 'night' },
    xp: 70,
    rarity: 'epico',
    category: 'segredo',
    hidden: true,
    tip: 'Você apareceu de madrugada.',
  },
  {
    id: 'triple-threat',
    title: 'Ameaça tripla',
    desc: 'Deixe microfone, câmera e tela ligados ao mesmo tempo.',
    emoji: '🔥',
    goal: 1,
    progress: { counter: 'combo' },
    xp: 90,
    rarity: 'epico',
    category: 'segredo',
    hidden: true,
  },
  {
    id: 'gg',
    title: 'GG, bem jogado',
    desc: 'Fique 3 horas seguidas na mesma sessão.',
    emoji: '🏆',
    goal: 180,
    progress: { counter: 'longestSession' },
    xp: 120,
    rarity: 'lendario',
    category: 'segredo',
    hidden: true,
    tip: 'Uma sessão inteira sem sair da sala.',
  },
  {
    id: 'ghost',
    title: 'Modo fantasma',
    desc: 'Fique ausente 5 vezes.',
    emoji: '👻',
    goal: 5,
    progress: { counter: 'aways' },
    xp: 50,
    rarity: 'raro',
    category: 'segredo',
    hidden: true,
  },
  {
    id: 'combo-breaker',
    title: 'DJ possuído',
    desc: 'Toque 3 sons em menos de 10 segundos.',
    emoji: '🎚️',
    goal: 1,
    progress: { counter: 'soundCombo' },
    xp: 60,
    rarity: 'epico',
    category: 'segredo',
    hidden: true,
  },
];

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

export type GameEvent =
  | { type: 'room.join'; roomId: string; transport: 'livekit' | 'p2p' }
  | { type: 'room.create' }
  | { type: 'mic.on' }
  | { type: 'camera.on' }
  | { type: 'screen.share' }
  | { type: 'chat.send' }
  | { type: 'sound.play' }
  | { type: 'overlay.open' }
  | { type: 'away.on' }
  | { type: 'theme.use'; theme: string }
  | { type: 'peak.people'; count: number }
  | { type: 'session.minute' }
  | { type: 'session.longest'; minutes: number }
  | { type: 'combo.av' }
  | { type: 'night.owl' }
  | { type: 'sound.combo' };

// ---------------------------------------------------------------------------
// Estado persistido
// ---------------------------------------------------------------------------

interface GamData {
  /** Contadores monotônicos (ou de máximo, no caso de pico/sessão). */
  counters: Record<string, number>;
  /** Conjuntos de valores distintos (temas vistos, salas visitadas…). */
  sets: Record<string, string[]>;
  /** id da missão -> quando foi concluída. */
  completed: Record<string, number>;
  /** Quantas conclusões o modal já mostrou — base do "selo de novidade". */
  lastSeenCompleted: number;
}

export interface Celebration {
  id: number;
  kind: 'mission' | 'rank';
  emoji: string;
  title: string;
  subtitle: string;
  reward: string;
  rarity: Rarity;
  color: string;
}

export interface MissionView extends Mission {
  value: number;
  done: boolean;
  /** Visível ou ainda escondida (segredo não concluído). */
  revealed: boolean;
}

export interface MedalView extends Rank {
  unlocked: boolean;
  current: boolean;
}

export interface GamSnapshot {
  xp: number;
  rank: Rank;
  rankIndex: number;
  nextRank: Rank | null;
  /** 0..1 dentro do posto atual. */
  progressToNext: number;
  xpIntoRank: number;
  xpForNext: number;
  missions: MissionView[];
  medals: MedalView[];
  completedCount: number;
  totalCount: number;
  /** Conclusões ainda não vistas no modal. */
  badge: number;
  celebration: Celebration | null;
}

const STORAGE_KEY = 'telecord.gamification.v1';

function emptyData(): GamData {
  return { counters: {}, sets: {}, completed: {}, lastSeenCompleted: 0 };
}

function load(): GamData {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return emptyData();
    const parsed = JSON.parse(raw) as Partial<GamData>;
    return {
      counters: parsed.counters ?? {},
      sets: parsed.sets ?? {},
      completed: parsed.completed ?? {},
      lastSeenCompleted: parsed.lastSeenCompleted ?? 0,
    };
  } catch {
    // Storage bloqueado ou JSON corrompido: começa do zero, sem quebrar.
    return emptyData();
  }
}

function save(data: GamData): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Modo privado / storage cheio: a sessão continua valendo em memória.
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type Listener = () => void;

const listeners = new Set<Listener>();
let data: GamData = load();
let celebrations: Celebration[] = [];
let nextCelebrationId = 1;
let snapshot: GamSnapshot = build();

/** Disparos de som recentes, para detectar o combo de 3-em-10-segundos. */
const recentSoundPlays: number[] = [];

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function readValue(source: Progress): number {
  if ('counter' in source) {
    return data.counters[source.counter] ?? 0;
  }
  return data.sets[source.set]?.length ?? 0;
}

function totalXp(): number {
  let sum = 0;
  for (const id of Object.keys(data.completed)) {
    const mission = MISSIONS.find((m) => m.id === id);
    if (mission !== undefined) sum += mission.xp;
  }
  return sum;
}

function rankIndexForXp(xp: number): number {
  let index = 0;
  for (let i = 0; i < RANKS.length; i += 1) {
    const rank = RANKS[i];
    if (rank !== undefined && xp >= rank.xp) index = i;
  }
  return index;
}

/** Posto por índice, sempre válido: fora da faixa, prende nas pontas. */
function rankAt(index: number): Rank {
  const clamped = Math.max(0, Math.min(index, RANKS.length - 1));
  // RANKS é uma constante não vazia; o clamp garante um índice existente.
  return RANKS[clamped] as Rank;
}

const RARITY_COLOR: Record<Rarity, string> = {
  comum: '#8b93a5',
  raro: '#6fb0e6',
  epico: '#8f7ce0',
  lendario: '#e0a84e',
};

function build(): GamSnapshot {
  const xp = totalXp();
  const rankIndex = rankIndexForXp(xp);
  const rank = rankAt(rankIndex);
  const nextRank = RANKS[rankIndex + 1] ?? null;
  const floor = rank.xp;
  const ceil = nextRank !== null ? nextRank.xp : rank.xp;
  const xpIntoRank = xp - floor;
  const xpForNext = nextRank !== null ? ceil - floor : 0;
  const progressToNext = nextRank !== null ? clamp01(xpIntoRank / xpForNext) : 1;

  const missions: MissionView[] = MISSIONS.map((mission) => {
    const raw = readValue(mission.progress);
    const done = mission.id in data.completed;
    return {
      ...mission,
      value: Math.min(raw, mission.goal),
      done,
      revealed: mission.hidden !== true || done,
    };
  });

  const medals: MedalView[] = RANKS.map((r, i) => ({
    ...r,
    unlocked: i <= rankIndex,
    current: i === rankIndex,
  }));

  const completedCount = Object.keys(data.completed).length;

  return {
    xp,
    rank,
    rankIndex,
    nextRank,
    progressToNext,
    xpIntoRank,
    xpForNext,
    missions,
    medals,
    completedCount,
    totalCount: MISSIONS.length,
    badge: Math.max(0, completedCount - data.lastSeenCompleted),
    celebration: celebrations[0] ?? null,
  };
}

function emit(): void {
  snapshot = build();
  for (const listener of listeners) listener();
}

function reduce(event: GameEvent): void {
  const inc = (key: string, by = 1): void => {
    data.counters[key] = (data.counters[key] ?? 0) + by;
  };
  const max = (key: string, value: number): void => {
    data.counters[key] = Math.max(data.counters[key] ?? 0, value);
  };
  const flag = (key: string): void => {
    data.counters[key] = 1;
  };
  const addTo = (key: string, value: string): void => {
    const current = data.sets[key] ?? [];
    if (!current.includes(value)) {
      data.sets[key] = [...current, value];
    }
  };

  switch (event.type) {
    case 'room.join':
      inc('joins');
      addTo('rooms', event.roomId);
      addTo('transports', event.transport);
      break;
    case 'room.create':
      inc('roomsCreated');
      break;
    case 'mic.on':
      inc('mics');
      break;
    case 'camera.on':
      inc('cameras');
      break;
    case 'screen.share':
      inc('screens');
      break;
    case 'chat.send':
      inc('chats');
      break;
    case 'sound.play':
      inc('sounds');
      break;
    case 'overlay.open':
      inc('overlays');
      break;
    case 'away.on':
      inc('aways');
      break;
    case 'theme.use':
      addTo('themes', event.theme);
      break;
    case 'peak.people':
      max('peak', event.count);
      break;
    case 'session.minute':
      inc('minutes');
      break;
    case 'session.longest':
      max('longestSession', event.minutes);
      break;
    case 'combo.av':
      flag('combo');
      break;
    case 'night.owl':
      flag('night');
      break;
    case 'sound.combo':
      flag('soundCombo');
      break;
  }
}

/**
 * Anota um evento e faz o resto: marca missões concluídas, enfileira as
 * animações, detecta subida de posto e salva. A interface só reage.
 */
export function trackEvent(event: GameEvent): void {
  if (typeof window === 'undefined') return;

  const rankBefore = rankIndexForXp(totalXp());
  reduce(event);

  // Missões que acabaram de fechar viram celebração — na ordem do catálogo,
  // para que "primeiros passos" apareçam antes dos segredos num mesmo disparo.
  let mudou = false;
  for (const mission of MISSIONS) {
    if (mission.id in data.completed) continue;
    if (readValue(mission.progress) >= mission.goal) {
      data.completed[mission.id] = Date.now();
      celebrations.push({
        id: nextCelebrationId++,
        kind: 'mission',
        emoji: mission.emoji,
        title: mission.title,
        subtitle: 'Missão concluída',
        reward: `+${mission.xp} XP`,
        rarity: mission.rarity,
        color: RARITY_COLOR[mission.rarity],
      });
      mudou = true;
    }
  }

  // Subiu de posto? A medalha nova entra na fila DEPOIS das missões que a
  // renderam — a ordem conta a história: "fechei a missão… e virei Lenda".
  const rankAfter = rankIndexForXp(totalXp());
  if (rankAfter > rankBefore) {
    const novo = rankAt(rankAfter);
    celebrations.push({
      id: nextCelebrationId++,
      kind: 'rank',
      emoji: novo.emoji,
      title: novo.name,
      subtitle: 'Nova medalha',
      reward: `Nível ${rankAfter + 1}`,
      rarity: 'lendario',
      color: novo.color,
    });
    mudou = true;
  }

  if (mudou) save(data);
  emit();
}

/**
 * Registra um som tocado. Além do contador, cuida do combo secreto: 3 sons
 * numa janela de 10 segundos. Fica aqui, e não em quem chama, porque a janela
 * é estado que precisa sobreviver entre disparos.
 */
export function trackSoundPlayed(): void {
  const agora = Date.now();
  recentSoundPlays.push(agora);
  // Mantém só o que caiu nos últimos 10 s.
  while (recentSoundPlays.length > 0) {
    const primeiro = recentSoundPlays[0];
    if (primeiro === undefined || agora - primeiro <= 10_000) break;
    recentSoundPlays.shift();
  }
  trackEvent({ type: 'sound.play' });
  if (recentSoundPlays.length >= 3) {
    trackEvent({ type: 'sound.combo' });
  }
}

/** Zera o selo de novidade: tudo que está concluído passa a "já visto". */
export function markMissionsSeen(): void {
  const count = Object.keys(data.completed).length;
  if (data.lastSeenCompleted === count) return;
  data.lastSeenCompleted = count;
  save(data);
  emit();
}

/** Tira a celebração da frente da fila para a próxima aparecer. */
export function dismissCelebration(): void {
  if (celebrations.length === 0) return;
  celebrations = celebrations.slice(1);
  emit();
}

/** Apaga todo o progresso (usado por quem quiser recomeçar). */
export function resetGamification(): void {
  data = emptyData();
  celebrations = [];
  save(data);
  emit();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): GamSnapshot {
  return snapshot;
}
