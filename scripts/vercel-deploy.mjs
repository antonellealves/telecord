/**
 * Sincroniza as credenciais no projeto da Vercel e publica um commit.
 *
 * Fala direto com a API REST, sem a CLI. Motivo: a CLI resolve a conta antes
 * de qualquer comando, e um token com escopo de projeto (prefixo `vcp_`) lê o
 * projeto mas não resolve usuário nem time — todo comando morre em
 * "Could not retrieve Project Settings". A API aceita esse token sem problema.
 *
 * Ambiente esperado:
 *   VERCEL_TOKEN          obrigatório
 *   LIVEKIT_API_KEY       obrigatório
 *   LIVEKIT_API_SECRET    obrigatório
 *   VITE_LIVEKIT_URL      opcional (o código tem default versionado)
 *   GITHUB_SHA            commit a publicar; sem ele, usa o branch de produção
 *   GITHUB_OUTPUT         opcional; recebe url= e inspector=
 *
 * Nenhum valor de credencial é impresso.
 */
import { appendFileSync, readFileSync } from 'node:fs';

const API = 'https://api.vercel.com';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 20 * 60 * 1000;

function required(name) {
  const value = process.env[name];
  if (!value) {
    fail(`${name} não está definida no ambiente.`);
  }
  return value;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const token = required('VERCEL_TOKEN');
const { projectId, orgId } = JSON.parse(readFileSync('.vercel/project.json', 'utf8'));

const authHeaders = { Authorization: `Bearer ${token}` };
const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' };
const team = `teamId=${orgId}`;

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, init);
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// ---------------------------------------------------------------------------
// 1. O token enxerga o projeto?
// ---------------------------------------------------------------------------

const project = await api(`/v9/projects/${projectId}?${team}`, { headers: authHeaders });
if (!project.ok) {
  fail(
    `O VERCEL_TOKEN não consegue ler o projeto ${projectId} ` +
      `(${project.status} ${project.body?.error?.code ?? ''}). ` +
      'Confira se o token pertence à conta dona do projeto e não expirou.',
  );
}
console.log(`Projeto: ${project.body.name}`);

const link = project.body.link;
if (!link?.repoId) {
  fail('O projeto não está ligado a um repositório git na Vercel — o deploy por commit depende disso.');
}

// ---------------------------------------------------------------------------
// 2. Credenciais de runtime
// ---------------------------------------------------------------------------

async function upsertEnv(key, value) {
  const res = await api(`/v10/projects/${projectId}/env?upsert=true&${team}`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      key,
      value,
      type: 'encrypted',
      target: ['production', 'preview', 'development'],
    }),
  });
  if (!res.ok) {
    fail(`Falha ao gravar ${key}: ${res.status} ${res.body?.error?.message ?? ''}`);
  }
  console.log(`  ${key} sincronizada`);
}

console.log('Sincronizando credenciais:');
await upsertEnv('LIVEKIT_API_KEY', required('LIVEKIT_API_KEY'));
await upsertEnv('LIVEKIT_API_SECRET', required('LIVEKIT_API_SECRET'));
if (process.env.VITE_LIVEKIT_URL) {
  await upsertEnv('VITE_LIVEKIT_URL', process.env.VITE_LIVEKIT_URL);
}

/*
 * Autenticação.
 *
 * Todas OPCIONAIS, e a ausência delas é um estado válido: sem elas o app
 * publicado não tem contas e se comporta como antes de a autenticação existir.
 * Por isso nenhuma passa por `required()` — faltar não pode derrubar o deploy
 * de quem ainda não ligou o recurso.
 *
 * `AUTH_JWT_PUBLIC_KEY` e `VITE_API_URL` não são segredo: a primeira é a
 * metade pública do par, que VALIDA o access token e não emite nenhum; a
 * segunda é um endereço, e vai para o bundle de qualquer forma. As demais são,
 * e por isso saem de `secrets` no workflow.
 *
 * O PEM aceita quebra de linha de verdade ou `
` escrito, que é o que cabe
 * num campo de uma linha só.
 */
const AUTH_ENV = [
  'DATABASE_URL',
  'AUTH_JWT_PRIVATE_KEY',
  'AUTH_JWT_PUBLIC_KEY',
  'AUTH_ACCESS_TTL_SECONDS',
  'AUTH_REFRESH_TTL_DAYS',
  'AUTH_COOKIE_SAMESITE',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MAIL_DRIVER',
  'MAIL_FROM',
  'RESEND_API_KEY',
  'APP_URL',
  'API_URL',
  'VITE_API_URL',
];

/*
 * O que NÃO chegou é tão informativo quanto o que chegou, e antes disto o
 * silêncio custou caro: faltando `DATABASE_URL` e as chaves do JWT, o serviço
 * recusava subir em produção e aqui não se via nada — o deploy seguia verde e
 * o motivo só aparecia no log de runtime da função.
 *
 * Lista só NOMES, nunca valor. Quem está publicando precisa ver, no log do
 * deploy, exatamente quais variáveis o ambiente não entregou.
 */
const ausentes = [];
for (const key of AUTH_ENV) {
  if (process.env[key]) {
    await upsertEnv(key, process.env[key]);
  } else {
    ausentes.push(key);
  }
}

if (ausentes.length > 0) {
  console.log(`\n  não vieram do ambiente: ${ausentes.join(', ')}`);
}

/*
 * Estas três o serviço de autenticação EXIGE para subir (`loadConfig`). Sem
 * qualquer uma delas, toda rota sob `/api/` que não seja `token` ou `rooms`
 * responde 503 — login e cadastro inclusive. Não falha o deploy, porque
 * publicar sem contas é um estado legítimo do produto, mas avisa alto.
 */
const ESSENCIAIS = ['DATABASE_URL', 'AUTH_JWT_PRIVATE_KEY', 'AUTH_JWT_PUBLIC_KEY'];
const faltando = ESSENCIAIS.filter((k) => !process.env[k]);
if (faltando.length > 0) {
  console.log(
    `::warning::Sem ${faltando.join(', ')} o serviço de autenticação não sobe: ` +
      'login, cadastro e painel responderão 503. ' +
      'Configure em Settings → Secrets and variables → Actions (Environment "Production").',
  );
}

// ---------------------------------------------------------------------------
// 3. Deploy do commit
// ---------------------------------------------------------------------------

const ref = process.env.GITHUB_SHA || link.productionBranch || 'main';
console.log(`\nPublicando ${ref.slice(0, 7)} em produção…`);

const created = await api(`/v13/deployments?${team}&forceNew=1`, {
  method: 'POST',
  headers: jsonHeaders,
  body: JSON.stringify({
    name: project.body.name,
    target: 'production',
    gitSource: { type: link.type, repoId: link.repoId, ref },
  }),
});

if (!created.ok) {
  fail(`Não foi possível criar o deployment: ${created.status} ${created.body?.error?.message ?? ''}`);
}

const deploymentId = created.body.id;
const inspector = created.body.inspectorUrl ?? '';
console.log(`  id: ${deploymentId}`);
if (inspector) console.log(`  logs: ${inspector}`);

// ---------------------------------------------------------------------------
// 4. Espera terminar
// ---------------------------------------------------------------------------

const startedAt = Date.now();
let state = created.body.readyState ?? 'QUEUED';
let deployment = created.body;

while (!['READY', 'ERROR', 'CANCELED'].includes(state)) {
  if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
    fail(`O deployment não terminou em ${POLL_TIMEOUT_MS / 60000} minutos (último estado: ${state}).`);
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  const polled = await api(`/v13/deployments/${deploymentId}?${team}`, { headers: authHeaders });
  if (!polled.ok) continue;
  deployment = polled.body;
  const next = deployment.readyState ?? deployment.status;
  if (next !== state) {
    state = next;
    console.log(`  ${state}`);
  }
}

if (state !== 'READY') {
  fail(`Deployment terminou em ${state}.${inspector ? ` Logs: ${inspector}` : ''}`);
}

// A URL de produção é o alias mais curto; as outras são por-deploy.
const aliases = Array.isArray(deployment.alias) ? deployment.alias : [];
const productionUrl = aliases.length > 0
  ? `https://${aliases.reduce((a, b) => (a.length <= b.length ? a : b))}`
  : `https://${deployment.url}`;

console.log(`\nPublicado: ${productionUrl}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `url=${productionUrl}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, `inspector=${inspector}\n`);
}
