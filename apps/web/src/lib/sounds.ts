/**
 * Catálogo do soundboard.
 *
 * A lista NÃO é escrita à mão: ela é montada a partir dos arquivos em
 * `apps/web/src/assets/sons/`. Para acrescentar um som, largue o arquivo lá —
 * o nome do arquivo vira o rótulo e o id, e ele aparece no painel. Nada de
 * editar código para cada clipe novo.
 *
 * Por que `src/assets` e não `public`: aqui os arquivos passam pelo build, que
 * é o que permite descobrir a pasta com `import.meta.glob` e o que dá a cada
 * arquivo uma URL com hash — trocar o conteúdo de um som invalida o cache
 * sozinho, em vez de deixar metade da sala com a versão antiga.
 *
 * O `id` trafega pelo canal de dados e é validado do outro lado por
 * `parseRoomMessage`, então ele é gerado já dentro do formato aceito. O som em
 * si nunca trafega: cada cliente toca o arquivo que já baixou, o que exige que
 * todo mundo esteja na mesma versão do app.
 */
export interface SoundEntry {
  id: string;
  label: string;
  file: string;
}

/** Mesmo limite de `/^[a-z0-9-]{1,32}$/` no contrato de @telecord/shared. */
const MAX_ID_LENGTH = 32;

const FALLBACK_ID = 'som';

/*
 * `eager` porque o catálogo precisa existir de forma síncrona na primeira
 * renderização do painel; `?url` porque o que queremos é o endereço do arquivo,
 * não o conteúdo dele dentro do bundle.
 */
const modules = import.meta.glob<string>('../assets/sons/*.{mp3,ogg,oga,opus,wav,m4a,aac,flac,webm}', {
  eager: true,
  query: '?url',
  import: 'default',
});

function baseName(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  const dot = file.lastIndexOf('.');
  // `dot > 0`, não `>= 0`: um arquivo ".alguma-coisa" é nome, não extensão.
  return dot > 0 ? file.slice(0, dot) : file;
}

function toId(name: string): string {
  const slug = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // marcas de acento soltas pelo NFD
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_ID_LENGTH)
    .replace(/-+$/g, '');
  return slug === '' ? FALLBACK_ID : slug;
}

function toLabel(name: string, id: string): string {
  const text = name
    // Controle, formatação, substitutos e uso privado não desenham nada. O
    // Windows troca caractere proibido em nome de arquivo por uso privado
    // ("?" vira U+F03F), o que daria um botão de rótulo invisível.
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}]/gu, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text === '') {
    // Cai para o id, que passou pelo mesmo saneamento e é sempre legível.
    return `${id.charAt(0).toUpperCase()}${id.slice(1)}`;
  }
  // Só a primeira letra: "Olha a maconha" lê melhor que "Olha A Maconha".
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * Dois arquivos podem colidir depois do slug ("Ilariê.mp3" e "ilarie.wav").
 * Colisão silenciosa faria um som tocar no lugar do outro na sala inteira, então
 * o segundo ganha sufixo — sem estourar o limite de tamanho do id.
 */
function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; n < 100; n += 1) {
    const suffix = `-${n}`;
    const head = base.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/g, '');
    const candidate = `${head === '' ? FALLBACK_ID : head}${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return base;
}

function buildCatalog(): SoundEntry[] {
  const taken = new Set<string>();
  const entries: SoundEntry[] = [];

  // Ordena os caminhos ANTES de gerar os ids: assim o desempate de colisão dá
  // sempre o mesmo resultado, independente da ordem em que o glob resolveu.
  for (const path of Object.keys(modules).sort()) {
    const file = modules[path];
    if (file === undefined) {
      continue;
    }
    const name = baseName(path);
    const id = uniqueId(toId(name), taken);
    taken.add(id);
    entries.push({ id, label: toLabel(name, id), file });
  }

  entries.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  return entries;
}

export const SOUNDS: SoundEntry[] = buildCatalog();

const byId = new Map(SOUNDS.map((sound) => [sound.id, sound]));

export function findSound(soundId: string): SoundEntry | undefined {
  return byId.get(soundId);
}
