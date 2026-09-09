# Telecord

Sala de reunião web, efêmera e sem cadastro: **uma pessoa compartilha a tela, até 20 participantes falam e ouvem**. Sem banco de dados, sem estado no servidor além do próprio SFU.

A especificação técnica completa — incluindo as decisões e os limites conhecidos — está em [SPEC.md](./SPEC.md).

```
/
├── apps/web/          Vite + React + TS (SPA)
├── packages/shared/   contrato e validação usados pelos dois lados
├── api/token.ts       função serverless da Vercel: emite o JWT do LiveKit
├── scripts/           guard-rail que barra credencial no bundle
├── vercel.json
└── pnpm-workspace.yaml
```

## Como funciona

```
Browser ──POST /api/token──> Vercel (Node) ──assina JWT──┐
   │                                                     │
   └──────────wss:// + WebRTC──────────> LiveKit Cloud <──┘ (valida o mesmo JWT)
```

A função serverless é o único lugar que toca no secret do LiveKit. Todo o estado da sala (quem está dentro, quem fala, quem compartilha) vive na memória do SFU e é derivado dos eventos do `Room` — não há persistência em lugar nenhum.

## Rodando local

Requisitos: **Node 22+** e **pnpm 9** (via corepack: `corepack enable pnpm`).

```bash
pnpm install
cp .env.example .env      # e preencha com as suas credenciais
pnpm dev                  # http://localhost:5173
```

`pnpm dev` sobe só o Vite — que também executa `api/token.ts` no próprio middleware, na mesma origem, com o mesmo código que roda na Vercel. Não é preciso a CLI da Vercel para desenvolver.

Scripts da raiz:

| Comando | O que faz |
|---|---|
| `pnpm dev` | Vite + `/api/token` em `localhost:5173` |
| `pnpm build` | compila `shared`, builda a SPA e roda o guard-rail de credenciais |
| `pnpm typecheck` | `tsc --noEmit` em `shared`, `web`, `vite.config.ts` e `api/` |
| `pnpm lint` | alias de `typecheck` (não há ESLint: fora da lista de dependências permitidas) |

## Criando o projeto no LiveKit Cloud

1. Crie a conta em <https://cloud.livekit.io> e um projeto (escolha a região mais próxima dos participantes).
2. Em **Settings → Keys**, gere um par de chaves. Você vai usar três valores:
   - a **API Key** (`APIxxxx…`) → `LIVEKIT_API_KEY`
   - o **API Secret** → `LIVEKIT_API_SECRET`
   - a **WebSocket URL** do projeto (`wss://<seu-projeto>.livekit.cloud`) → `VITE_LIVEKIT_URL`
3. Opcional: em **Settings**, ajuste o *empty timeout* das salas. É ele que define quanto tempo uma sala vazia sobrevive antes de ser destruída — o app não cria nem destrói salas.

Nenhum outro recurso do LiveKit precisa ser configurado: a sala é criada no primeiro `join`.

## Variáveis de ambiente

| Nome | Escopo | Público? |
|---|---|---|
| `LIVEKIT_API_KEY` | runtime, servidor | **não** |
| `LIVEKIT_API_SECRET` | runtime, servidor | **não** |
| `VITE_LIVEKIT_URL` | build do Vite | **sim** — vai para o bundle |
| `VITE_TOKEN_ENDPOINT` | build do Vite, opcional | sim (default `/api/token`) |

> **Só o prefixo `VITE_` expõe uma variável ao navegador — e o que vai para o bundle é legível por qualquer visitante.** Nunca prefixe a key ou o secret com `VITE_`. Se o secret vazar, qualquer pessoa emite token para qualquer sala: rotacione a chave no dashboard do LiveKit.
>
> O `pnpm build` roda `scripts/check-bundle.mjs`, que falha o build se encontrar `LIVEKIT_API_` ou o valor do secret dentro de `apps/web/dist`.

## Deploy na Vercel

1. **Importe o repositório** na Vercel.
2. Em **Settings → General**:
   - **Root Directory**: a raiz do repositório (`./`). Se apontar para `apps/web`, o diretório `api/` deixa de ser detectado e a função de token não existe.
   - **Framework Preset**: Vite. Build Command, Output Directory e Install Command já vêm do [vercel.json](./vercel.json).
   - **Node.js Version**: 22.x.
3. Em **Settings → Environment Variables**, adicione as variáveis acima em **Production**, **Preview** e **Development**. Marque key e secret como *Sensitive* se quiser escondê-las da interface.
4. **Faça um Redeploy** (Deployments → ⋯ → Redeploy, com o cache desmarcado).

   > A Vercel dispara o primeiro build assim que você importa o repositório — ou seja, **antes** de existirem as variáveis. Como `VITE_LIVEKIT_URL` é congelada dentro do bundle no momento do build, esse primeiro deploy sobe um app que mostra "Configuração incompleta" em toda sala, mesmo depois de você cadastrar a variável. Só um novo build resolve. Vale para qualquer alteração futura em variáveis `VITE_*`.

A cada push a Vercel roda `pnpm install --frozen-lockfile` e depois `pnpm run build`; as funções de `api/` são compiladas em seguida, já com `packages/shared/dist` pronto.

O `vercel.json` cuida do rewrite de SPA (`/sala/:id` recarrega sem 404) sem capturar `/api/*`.

### Conferindo que subiu certo

```bash
# 1. a função responde e assina o token
curl -s -X POST https://SEU-APP.vercel.app/api/token \
  -H 'Content-Type: application/json' \
  -d '{"roomId":"teste-de-deploy","displayName":"Ana"}'
# 200 + { "token": "eyJ…", "identity": "…" }  → key e secret OK
# 500 SERVER_MISCONFIGURED                     → falta variável no runtime

# 2. a SPA recarrega dentro da sala (rewrite)
curl -s -o /dev/null -w '%{http_code}\n' https://SEU-APP.vercel.app/sala/teste-de-deploy
# 200

# 3. rota de API inexistente devolve 404, e não o HTML da SPA
curl -s -o /dev/null -w '%{http_code}\n' https://SEU-APP.vercel.app/api/nada
# 404
```

Se o token vier certo mas a sala não conectar, o problema é a `VITE_LIVEKIT_URL` — ela é de build, não de runtime: confira o valor e faça o redeploy.

## Notas de operação

- **Todo mundo entra mutado.** O microfone só é publicado no primeiro clique em "Falar" — é aí que o navegador pede permissão.
- **Uma tela por vez.** A regra é resolvida no cliente e tem uma corrida conhecida: se duas pessoas clicarem quase juntas, as duas publicam por ~1 segundo, e então todos os clientes aplicam o mesmo desempate (menor `trackSid` vence) e a segunda tela é recolhida sozinha. Fechar isso de verdade exige estado no servidor — ver §4 do SPEC.
- **Áudio de aba** só existe em Chromium no desktop. Firefox e Safari não entregam áudio no `getDisplayMedia`.
- **iOS** não compartilha tela (`getDisplayMedia` não existe lá): dá para ouvir e falar, não para apresentar.
- **Banda.** Com 20 pessoas e a tela em 1080p@15fps, o SFU envia ~26 GB por hora de reunião. Se a cota do plano free apertar, troque o preset para `h720fps15` em `apps/web/src/lib/media.ts`.
- **Trocar de servidor LiveKit** (Cloud → self-host) é mudar `VITE_LIVEKIT_URL` e as credenciais, e refazer o deploy. O código não muda.
