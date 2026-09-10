/**
 * Guard-rail da §7 do SPEC: falha o build se alguma credencial do LiveKit
 * tiver vazado para o bundle do navegador.
 *
 * Roda depois de `vite build`. Procura em apps/web/dist:
 *  - o literal "LIVEKIT_API_" (nome de variável privada em qualquer forma)
 *  - o valor real do secret/key, quando presentes no ambiente do build
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const DIST = resolve(process.cwd(), 'apps/web/dist');

/** @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : Promise.resolve([full]);
    }),
  );
  return files.flat();
}

/** @type {{ label: string, needle: string }[]} */
const needles = [
  { label: 'nome de variável privada', needle: 'LIVEKIT_API_' },
  { label: 'nome de variável privada', needle: 'GOOGLE_CLIENT_SECRET' },
  { label: 'nome de variável privada', needle: 'AUTH_JWT_PRIVATE_KEY' },
  { label: 'nome de variável privada', needle: 'RESEND_API_KEY' },
  // O cabeçalho do PEM: pega qualquer chave privada que vaze para o bundle,
  // inclusive uma colada à mão em algum arquivo do front.
  { label: 'chave privada em PEM', needle: 'BEGIN PRIVATE KEY' },
];

for (const name of [
  'LIVEKIT_API_SECRET',
  'LIVEKIT_API_KEY',
  'GOOGLE_CLIENT_SECRET',
  'AUTH_JWT_PRIVATE_KEY',
  'RESEND_API_KEY',
]) {
  const value = process.env[name];
  if (value && value.length >= 8) {
    needles.push({ label: `valor de ${name}`, needle: value });
  }
}

let files;
try {
  files = await walk(DIST);
} catch {
  console.error(`check-bundle: ${DIST} não existe. Rode o build do web antes.`);
  process.exit(1);
}

const leaks = [];
for (const file of files) {
  if (!/\.(js|mjs|css|html|map|json)$/.test(file)) continue;
  const content = await readFile(file, 'utf8');
  for (const { label, needle } of needles) {
    if (content.includes(needle)) {
      leaks.push(`${relative(process.cwd(), file)} contém ${label}`);
    }
  }
}

if (leaks.length > 0) {
  console.error('check-bundle: CREDENCIAL NO BUNDLE. Build abortado.');
  for (const leak of leaks) console.error(`  - ${leak}`);
  process.exit(1);
}

console.log(`check-bundle: ok (${files.length} arquivos verificados, nenhuma credencial no bundle).`);
