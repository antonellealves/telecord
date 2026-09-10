# Telecord

Sala de reunião web, efêmera e sem cadastro: **até 20 participantes falam, ouvem, compartilham tela e conversam por texto**. Sem banco de dados, sem estado no servidor além do próprio SFU.

A especificação técnica completa — incluindo as decisões e os limites conhecidos — está em [SPEC.md](./SPEC.md).

```
/
├── apps/web/          Vite + React + TS (SPA)
├── packages/shared/   contrato e validação usados pelos dois lados
├── api/token.ts       função serverless da Vercel: emite o JWT do LiveKit
├── api/rooms.ts       lista as salas ativas para a página de entrada
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
2. Em **Settings → Keys**, gere um par de chaves:
   - a **API Key** (`APIxxxx…`) → `LIVEKIT_API_KEY`
   - o **API Secret** → `LIVEKIT_API_SECRET` (só é exibido na criação)
   - a **WebSocket URL** do projeto (`wss://<seu-projeto>.livekit.cloud`) já está versionada como default em [config.ts](apps/web/src/lib/config.ts); troque lá se for outro projeto
3. Opcional: em **Settings**, ajuste o *empty timeout* das salas. É ele que define quanto tempo uma sala vazia sobrevive antes de ser destruída — o app não cria nem destrói salas.

Nenhum outro recurso do LiveKit precisa ser configurado: a sala é criada no primeiro `join`.

## Variáveis de ambiente

| Nome | Escopo | Obrigatória? | Público? |
|---|---|---|---|
| `LIVEKIT_API_KEY` | runtime, servidor | **sim** | não |
| `LIVEKIT_API_SECRET` | runtime, servidor | **sim** | não |
| `VITE_LIVEKIT_URL` | build do Vite | não | sim — vai para o bundle |
| `VITE_TOKEN_ENDPOINT` | build do Vite | não | sim (default `/api/token`) |

A URL do servidor LiveKit tem default versionado em [config.ts](apps/web/src/lib/config.ts): ela é pública por natureza (o navegador precisa dela) e acaba no bundle de qualquer jeito, então versionar só elimina o risco de publicar um app que não conecta por falta de uma variável de build. Defina `VITE_LIVEKIT_URL` apenas para apontar para outro servidor.

**A key e o secret nunca podem ser versionados.** Eles são lidos do ambiente pela função serverless, e é por isso que precisam ser cadastrados na Vercel: um `.env` no repositório **não** é carregado no runtime das funções — o resultado seria expor o secret e continuar com `500 SERVER_MISCONFIGURED`.

> **Só o prefixo `VITE_` expõe uma variável ao navegador — e o que vai para o bundle é legível por qualquer visitante.** Nunca prefixe a key ou o secret com `VITE_`. Se o secret vazar, qualquer pessoa emite token para qualquer sala: rotacione a chave no dashboard do LiveKit.
>
> O `pnpm build` roda `scripts/check-bundle.mjs`, que falha o build se encontrar `LIVEKIT_API_` ou o valor do secret dentro de `apps/web/dist`.

## Contas (opcional)

O telecord funciona sem contas, e continua funcionando: digitar um nome e entrar
é o caminho principal. Ligar a autenticação acrescenta a possibilidade de entrar
com Google ou e-mail e senha, e nesse caso o nome deixa de ser auto-declarado —
o servidor passa a afirmá-lo (SPEC §2.4).

**Enquanto `VITE_API_URL` estiver vazia, nada disso existe no app publicado:**
nenhuma requisição sai, nenhum botão de entrar aparece. É seguro publicar este
código com o serviço de autenticação ainda fora do ar.

### Desenvolvimento local, com Docker

```bash
cp .env.example .env
node scripts/gen-auth-keys.mjs >> .env    # par de chaves Ed25519
docker compose up                          # TiDB + serviço de autenticação
pnpm dev                                   # front, noutra janela
```

O `docker-compose.yml` sobe **TiDB de verdade**, não MySQL. O protocolo é o
mesmo, mas as diferenças que interessam não são de protocolo: `AUTO_INCREMENT`
não monotônico, ausência de foreign key efetiva, sintaxe de TTL. Desenvolver
contra MySQL esconderia exatamente o que quebra em produção.

O front fica no host, e não no contêiner: o Vite dentro de um bind mount no
Windows só detecta alteração com polling, o que gasta CPU à toa e deixa o
recarregamento lento.

Sem credencial do Google e sem provedor de e-mail o serviço sobe assim mesmo —
o login social responde 503, o botão some da tela, e o link de confirmação de
e-mail é escrito no log em vez de enviado:

```bash
docker compose logs -f api      # o link de verificação sai aqui
```

### Criando as credenciais do Google

1. [Google Cloud Console](https://console.cloud.google.com) → crie ou escolha um projeto.
2. **APIs & Services → OAuth consent screen**: tipo *External*, preencha nome do
   app e e-mail de contato. Em desenvolvimento, adicione seu e-mail em *Test users*.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
   tipo *Web application*.
4. Em **Authorized redirect URIs**, ponha exatamente — sem barra no fim:
   ```
   http://localhost:3000/auth/google/callback     (local)
   https://api.seu-dominio.com/auth/google/callback  (produção)
   ```
   O Google compara caractere a caractere. Um `/` sobrando já recusa o login.
5. Copie o *Client ID* e o *Client secret* para `GOOGLE_CLIENT_ID` e
   `GOOGLE_CLIENT_SECRET` no `.env`. As duas vão juntas: metade da credencial
   faz o serviço recusar subir, de propósito.

### Criando o cluster no TiDB Cloud

1. [tidbcloud.com](https://tidbcloud.com) → **Create Cluster** → *Starter*
   (gratuito e permanente).
2. **Connect** → *Prisma* ou *General*. O host termina em `.tidbcloud.com` e a
   porta é **4000**, não 3306.
3. O usuário vem com o prefixo do cluster antes do ponto
   (`2abcXYZ.raiz`) — copie inteiro.
4. Monte a `DATABASE_URL`; `sslaccept=strict` e `connection_limit` não são
   opcionais:
   ```
   mysql://<prefixo>.<usuario>:<senha>@<host>:4000/telecord?sslaccept=strict&connection_limit=5
   ```
5. Aplique o schema:
   ```bash
   pnpm --filter @telecord/api exec prisma migrate deploy
   ```

### Publicando o serviço de autenticação

**Tudo na Vercel: app e API na mesma origem.** O serviço NestJS roda como
função, atrás de `api/[...nest].ts`, que captura tudo sob `/api/` que não tenha
função própria — `token` e `rooms` continuam sendo arquivos separados, porque
rota com segmento fixo tem precedência sobre rota dinâmica.

Isso resolve de graça o problema que era o maior risco do desenho: com a mesma
origem, o cookie de refresh é `SameSite=Lax` e não há cookie de terceiro para o
Safari bloquear. Não é preciso domínio próprio.

Em troca, volta o problema de conexão que um processo persistente não teria:
cada instância fria abre o próprio pool. Por isso **`connection_limit=1`** na
`DATABASE_URL` de produção — a invocação é curta e não tem o que reaproveitar.

O `apps/api/Dockerfile` continua no repositório, mas só para o desenvolvimento
local com Docker.

Todas as variáveis se criam no GitHub. **Elas se criam no GitHub, não na
Vercel**: o deploy por git está desligado e quem grava o ambiente do projeto é
`scripts/vercel-deploy.mjs`, a cada publicação. Editar direto no painel da
Vercel funciona até o próximo deploy sobrescrever.

Em **Settings → Secrets and variables → Actions**:

**Aba Secrets** — segredo de verdade:

| Nome | Valor |
|---|---|
| `DATABASE_URL` | a URL do TiDB, com a senha dentro |
| `AUTH_JWT_PRIVATE_KEY` | a metade que **assina** |
| `GOOGLE_CLIENT_SECRET` | do OAuth Client |
| `RESEND_API_KEY` | só se `MAIL_DRIVER=resend` |

**Aba Variables** — não são segredo:

| Nome | Valor |
|---|---|
| `AUTH_JWT_PUBLIC_KEY` | a metade **pública**: valida o token, não emite nenhum |
| `APP_URL` | `https://telecord.vercel.app` |
| `API_URL` | `https://telecord.vercel.app/api` |
| `VITE_API_URL` | `https://telecord.vercel.app/api` |
| `GOOGLE_CLIENT_ID` | do OAuth Client |
| `MAIL_DRIVER` / `MAIL_FROM` | `log` enquanto não houver provedor |

Todas são opcionais. Sem elas o app publicado simplesmente não tem contas, que é
o estado anterior a este trabalho — e o passo de verificação do deploy pula o
teste do serviço de autenticação sozinho.

`VITE_API_URL` e `API_URL` têm o mesmo valor aqui porque app e API dividem a
origem. Continuam separadas porque uma é lida no navegador, em tempo de build, e
a outra no servidor, em tempo de execução.

## Salas com nome e soundboard da sala

Duas coisas passaram a existir **em volta** da sala, sem mudar como se entra
nela — quem abre `/sala/qualquer-coisa` continua entrando sem conta, sem banco
e com o serviço de contas fora do ar.

**Dar nome à sala.** Dentro da sala, clique no nome dela no canto superior
esquerdo. Quem batiza fica como dono, e passa a poder renomeá-la, escolher
emoji, tirá-la do diretório e administrar os membros. Salas com nome aparecem
na tela inicial junto das que têm gente agora.

Não existe sala *privada*: `só por link` tira do diretório e nada além disso.
Quem emite o token de entrada é uma função sem acesso ao banco, e um cadeado
que ela não consegue conferir seria um cadeado desenhado na porta — o
raciocínio inteiro está em `PLANO.md §11.1`.

**Acrescentar um som à sala.** Abra o painel de sons e largue um arquivo de
áudio nele (ou use o botão de enviar). O nome do arquivo vira o rótulo. Exige
conta, porque o arquivo fica guardado e precisa ter dono para alguém poder
apagá-lo depois. Limite de 2 MB por arquivo e 120 sons por sala.

Os sons que ficam em `apps/web/src/assets/sons/` continuam existindo e valem
para **todas** as salas — eles viajam dentro do bundle, funcionam sem conta e
sem rede, e é por isso que não foram substituídos.

O servidor decide o formato pelos **bytes** do arquivo, não pelo que o
navegador declara. Um `.exe` renomeado para `.mp3` é recusado.

## Painel de administração

Em `/painel`, para contas com papel `ADMIN`. Tem quatro abas:

- **Visão geral** — indicadores comparados com o período anterior, séries
  diárias de entradas, minutos de conversa, cadastros e erros, além das salas
  mais movimentadas.
- **Log** — o que o servidor fez, com filtro por nível, escopo e busca.
  Expira sozinho em 30 dias, por `TTL` do TiDB.
- **Auditoria** — quem fez o quê, com o antes e o depois. Não expira.
- **Contas** — papel e situação. Suspender derruba as sessões abertas na hora.

Não há como ler senha nem entrar como outra pessoa por aqui — nem pela API. As
rotas de `/api/admin` são recusadas com 403 para conta comum **no servidor**,
com o guard aplicado no nível da classe: rota nova nasce restrita.

### Fazendo a primeira conta virar administradora

Não há tela para isso, de propósito: a primeira promoção tem que passar pelo
banco.

```sql
UPDATE `User` SET `role` = 'ADMIN' WHERE `email` = 'voce@exemplo.com';
```

Depois entre de novo — o papel viaja dentro do access token, e o que já estava
emitido continua dizendo `USER` até vencer.

### Webhook do LiveKit (entradas em sala e minutos de conversa)

Estes dois indicadores vêm do SFU, não do navegador: aba que fecha sem avisar e
número auto-declarado não servem para medir conversa. Configure em
**cloud.livekit.io → Project → Settings → Webhooks**:

```
https://telecord.vercel.app/api/livekit/webhook
```

O serviço confere a assinatura do evento contra o `LIVEKIT_API_SECRET` que já
existe — nenhuma credencial nova. Sem o webhook, o painel mostra zero nesses
dois indicadores **e avisa que não está medindo**, em vez de fingir que
ninguém conversou.

## Deploy

Quem publica é o **GitHub Actions**, não a Vercel. O deploy automático dela está desligado em [vercel.json](./vercel.json) (`git.deploymentEnabled: false`), e o pipeline está em [.github/workflows/deploy.yml](.github/workflows/deploy.yml).

```
push na main
   │
   ├─ verify ─── typecheck + build, sem nenhuma credencial
   │
   └─ deploy ─── scripts/vercel-deploy.mjs
                 · grava as credenciais no projeto da Vercel
                 · cria o deployment do commit exato e espera ficar READY
                 · verifica /api/token, rewrite de SPA e 404 de API
```

O passo de verificação no fim é o que impede um deploy "verde" mas quebrado: se `/api/token` não devolver 200, o job falha.

O deploy fala com a **API REST da Vercel**, não com a CLI, e sem nenhuma dependência além do `fetch` do Node. Isso não é preferência de estilo: a CLI resolve a conta antes de qualquer comando, então exige um token de conta. A API aceita também token com escopo de projeto (prefixo `vcp_`), que é o tipo gerado nas configurações do projeto.

### Por que as credenciais são empurradas para a Vercel

A função lê `LIVEKIT_API_KEY` e `LIVEKIT_API_SECRET` de `process.env`, e esse ambiente é fornecido pela plataforma no momento da invocação. **Deploy prebuilt não carrega `.env` para dentro do Lambda** — nenhum arquivo do repositório vira ambiente de runtime. Por isso o workflow sincroniza os dois segredos no projeto (`vercel env rm` + `vercel env add`) antes de publicar: os valores vivem nos GitHub Secrets, e o dashboard da Vercel nunca precisa ser aberto para isso.

Os valores não passam pelo log — a saída dos comandos é descartada, e o Actions ainda mascara qualquer secret que apareça.

### Configuração, uma vez só

1. **Gere um token da Vercel** — serve tanto um token de conta (<https://vercel.com/account/tokens>) quanto um com escopo de projeto, gerado nas configurações do próprio projeto.

2. **Cadastre 3 valores** no GitHub Environment chamado **`Production`** (*Settings → Environments → Production*). O nome precisa bater com o `environment:` do workflow.

   | Nome | Onde cadastrar | De onde vem |
   |---|---|---|
   | `VERCEL_TOKEN` | **secret** | o token do passo 1 |
   | `LIVEKIT_API_SECRET` | **secret** | LiveKit Cloud → Settings → Keys (só aparece na criação) |
   | `LIVEKIT_API_KEY` | secret ou variable | idem |

   Opcional: `VITE_LIVEKIT_URL` como *variable*, para sobrescrever o default versionado em [config.ts](apps/web/src/lib/config.ts).

   > **Secret e variable não são a mesma coisa.** Variables são texto plano: aparecem legíveis na tela de configuração e **não são mascaradas nos logs** do Actions. Credencial vai em *Environment secrets*. O workflow aceita as duas formas — `secrets` tem precedência e `vars` é o fallback —, e mascara à mão os valores sensíveis que chegarem como variable, mas isso é remendo: o lugar do token e do secret é em secrets.

   > `orgId` e `projectId` **não** precisam ser cadastrados: são identificadores, e estão versionados em [.vercel/project.json](.vercel/project.json) — o mesmo arquivo que `vercel link` gera. Com ele no repositório, a CLI já sabe em qual projeto está operando. Apontar para outro projeto é editar esse arquivo (ou rodar `npx vercel link` de novo).

3. Em **Settings → General** do projeto na Vercel, confira que **Root Directory** é a raiz (`./`) e o **Node.js Version** é 22.x. Se apontar para `apps/web`, o diretório `api/` não é detectado e a função de token não existe.

Depois disso, publicar é dar push na `main` — ou rodar o workflow à mão em *Actions → Deploy → Run workflow*.

> O push que introduz `git.deploymentEnabled: false` ainda pode disparar um último deploy automático, porque a Vercel lê essa configuração do commit que chegou. A partir do seguinte, ela para.

### Conferindo à mão

O workflow já faz isso, mas para checar fora dele:

```bash
curl -s -X POST https://SEU-APP.vercel.app/api/token \
  -H 'Content-Type: application/json' \
  -d '{"roomId":"teste-de-deploy","displayName":"Ana"}'
# 200 + { "token": "eyJ…", "identity": "…" }  → key e secret OK
# 500 SERVER_MISCONFIGURED                     → os secrets não chegaram ao projeto
```

Se o token vier certo mas a sala não conectar, o problema é a URL do servidor: confira o default em [config.ts](apps/web/src/lib/config.ts) (ou a `VITE_LIVEKIT_URL`, se você tiver definido uma). Como é valor de build, mudá-la exige um novo deploy.

## Notas de operação

- **A lista de salas ativas é pública.** Qualquer visitante da página inicial vê o nome de toda sala com gente dentro e entra com um clique. Antes dela, a sala só era alcançável por quem tivesse a URL. Se isso não servir, as saídas são autenticação, senha por sala, ou listar só as salas que a pessoa já visitou — nenhuma está implementada. Ver §9 do SPEC.

- **Todo mundo entra mutado.** O microfone só é publicado no primeiro clique em "Falar" — é aí que o navegador pede permissão.
- **Áudio de aba** só existe em Chromium no desktop. Firefox e Safari não entregam áudio no `getDisplayMedia`.
- **iOS** não compartilha tela (`getDisplayMedia` não existe lá): dá para ouvir e falar, não para apresentar.
- **Banda.** Com 20 pessoas e a tela em 1080p@15fps, o SFU envia ~26 GB por hora de reunião. Se a cota do plano free apertar, troque o preset para `h720fps15` em `apps/web/src/lib/media.ts`.
- **Sons do soundboard** ficam em `apps/web/src/assets/sons/`. Para acrescentar um som, largue o arquivo na pasta e faça o deploy: `apps/web/src/lib/sounds.ts` monta o catálogo a partir dela, então não há lista para editar. O nome do arquivo vira o rótulo (`gemidao-do-zap.mp3` → "Gemidao do zap") e o identificador que trafega pela sala. O som não trafega pela sala: cada cliente toca o próprio arquivo ao receber o aviso, então todo mundo precisa estar na mesma versão do app.
- **Várias pessoas podem compartilhar tela ao mesmo tempo.** Cada tela extra multiplica o egress do SFU — com o preset atual, duas telas já dobram a conta de banda acima.
- **Trocar de servidor LiveKit** (Cloud → self-host) é mudar `VITE_LIVEKIT_URL` e as credenciais, e refazer o deploy. O código não muda.
