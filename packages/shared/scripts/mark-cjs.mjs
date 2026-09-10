/**
 * Marca `dist/cjs` como CommonJS.
 *
 * O `package.json` do pacote diz `"type": "module"`, e isso vale para toda a
 * árvore abaixo dele — inclusive para os `.js` que o `tsc` acabou de emitir em
 * CommonJS. Sem este marcador, o Node lê a saída CJS como ESM e estoura em
 * `exports is not defined`. Um `package.json` de uma linha na subpasta é o
 * mecanismo oficial para inverter isso.
 */
import { mkdir, writeFile } from 'node:fs/promises';

const dir = new URL('../dist/cjs/', import.meta.url);
await mkdir(dir, { recursive: true });
await writeFile(new URL('package.json', dir), '{ "type": "commonjs" }\n');
