# PLANO.md — Autenticação por JWT + login social do Google

Escopo desta etapa: **autenticação de rotas com JWT e login com Google**. É a
primeira fatia do documento maior (Prisma + TiDB + dashboard admin); o resto do
§4 (Room/Channel/MediaSession/SystemLog…) e o dashboard ficam para etapas
seguintes, mas o que for decidido aqui condiciona todas elas.

Conforme §0 do documento: **nada foi implementado.** Este arquivo existe para
ser aprovado antes.

---

## 0. Decisões já tomadas por você

| Pergunta | Resposta |
|---|---|
| Login para entrar em sala | **Opcional** — anônimo continua entrando como hoje |
| Backend | **NestJS na Vercel**, mesma origem do app (revisado — ver §2.1) |
| Provedores | **Google + e-mail e senha** |

A escolha de host mudou durante a implementação: começou como serviço separado
e terminou na Vercel, como função, na mesma origem do app. Ficou NestJS, com o
guard declarativo que era o motivo de escolhê-lo. A §2.1 abaixo foi reescrita
para o que de fato existe.

---

## 1. O que já existe, e será reaproveitado

| Peça | Onde | Observação |
|---|---|---|
| SPA React + Vite | `apps/web/` | React 18, react-router-dom 6, CSS Modules |
| Rotas do app | `apps/web/src/App.tsx` | `/`, `/sala/:roomId`, `*` |
| Funções serverless | `api/token.ts`, `api/rooms.ts` | tipadas com `node:http`, **sem** `@vercel/node` |
| Contrato compartilhado | `packages/shared/src/index.ts` | validadores puros, sem dependência |
| Mídia | LiveKit Cloud | SFU gerenciado |
| Deploy | Vercel + `.github/workflows/deploy.yml` | `git.deploymentEnabled: false`, publica pela API |
| Guard de credencial | `scripts/check-bundle.mjs` | falha o build se segredo vazar para o bundle |
| Documento de decisões | `SPEC.md` | com emendas pós-implementação numeradas |

**Identidade hoje:** não existe. `displayName` mora no `localStorage`
(`useDisplayName`), é auto-declarado e falsificável; `api/token.ts` gera um
`identity` UUID novo a cada emissão. `SPEC.md §9` registra "Sem autenticação"
como limitação aceita, não como descuido.

---

## 2. Conflitos com a stack alvo

### 2.1 NestJS como função da Vercel

O serviço roda atrás de `api/[...nest].ts`, uma captura que pega tudo sob
`/api/` sem função própria. `api/token.ts` e `api/rooms.ts` seguem intactos:
rota com segmento fixo tem precedência sobre rota dinâmica.

**O que isso resolve.** O maior risco do desenho anterior era o cookie entre
sites: com a SPA em `*.vercel.app` e a API noutro domínio, o refresh precisaria
de `SameSite=None`, que o Safari bloqueia por padrão. Mesma origem elimina o
problema — `Lax` funciona, e não é preciso domínio próprio. Some também o
segundo deploy, o segundo host e o CORS em produção.

**O que isso custa.**

1. **O pool de conexões volta a ser problema.** Um processo persistente teria um
   pool só; aqui cada instância fria abre o seu, e a Vercel escala instâncias
   sob concorrência. Daí `connection_limit=1` na `DATABASE_URL` de produção: a
   invocação é curta e não tem o que reaproveitar.
2. **O limitador de requisições enfraquece.** `ThrottlerModule` guarda a contagem
   em memória do processo. Com N instâncias, o teto efetivo vira N × limite. Não
   é inútil — segura o caso comum —, mas não é barreira contra quem distribui a
   tentativa. Fechar de verdade exige contador compartilhado (KV/Redis), que
   está fora desta fatia.
3. **Boot do Nest a cada instância fria**, cerca de meio segundo. `vercel.ts`
   guarda a aplicação em escopo de módulo, então instância quente não paga nada.
4. **A função importa a saída COMPILADA**, não a fonte: o compilador de funções
   da Vercel não liga `emitDecoratorMetadata`, e sem isso todo `@Injectable`
   receberia `undefined`. Por isso `pnpm build` compila `apps/api` antes do
   front.

**O que continua valendo:** guard declarativo global (`APP_GUARD`), com rota
nova nascendo protegida — que era a razão de escolher NestJS. O que se perde é
o lugar natural para jobs periódicos (a reconciliação de sessões órfãs do §4),
que em função não tem onde rodar e vai precisar de cron da Vercel.

### 2.2 O que acontece com `api/token.ts` e `api/rooms.ts`

Ficam onde estão, como funções próprias. O access token vai por header
`Authorization: Bearer`, não por cookie, então `api/token.ts` o valida sozinho
com a chave pública — e `api/rooms.ts` não muda em nada.

### 2.3 Prisma + TiDB Starter

`connection_limit=1` em produção, pelo motivo da §2.1. Localmente, com o
processo em contêiner, 5 é seguro.

Um ponto a verificar no primeiro deploy: o motor de query do Prisma é binário
nativo, e o `binaryTargets` do schema já declara `rhel-openssl-3.0.x` para o
runtime da Vercel. Se a primeira consulta em produção reclamar de motor
ausente, a causa é o empacotamento não ter incluído o arquivo — e a correção é
`includeFiles` no `vercel.json` apontando para o `.prisma/client`.

### 2.4 O modelo de dados do §4 não descreve este produto

- O repo tem **salas planas** por slug, criadas na hora, sem persistência e sem
  dono. Não existe `Channel`, não existe `RoomMember`.
- Os sons **não são upload por canal**. São arquivos versionados em
  `apps/web/src/assets/sons/`, descobertos no build por `import.meta.glob` e
  servidos com hash de cache. Não há object storage, não há `storageKey`.

Não bloqueia a fatia de auth. Registro que **adotar o §4 não é acrescentar
tabelas: é reescrever o produto**, e merece etapa própria.

### 2.5 O `User` do §4 não comporta login social

`passwordHash` é obrigatório e não há campo de provedor. Com Google, quem entra
por lá nunca define senha. **Ajuste:** `passwordHash` opcional + tabela
`OAuthAccount`.

---

## 3. Segurança: o ponto que Google + senha cria

Suportar os dois provedores abre o **ataque de pré-vinculação de conta**:

1. Atacante registra por e-mail/senha usando `voce@gmail.com`, que não é dele;
2. você mais tarde entra com o Google desse mesmo e-mail;
3. se o sistema vincular por e-mail, você cai **dentro da conta do atacante**,
   que continua com a senha e lê tudo que é seu.

Regras que fecham isso, e que não são negociáveis na implementação:

- Conta criada por senha nasce com `emailVerifiedAt = null` e **não pode ser
  vinculada automaticamente** a um login social.
- Google só vincula a uma conta existente se `emailVerifiedAt` estiver
  preenchido **e** o `email_verified` do `id_token` for `true`.
- Caso contrário, o login social exige provar posse do e-mail antes de vincular.

Isso obriga **verificação de e-mail**, que obriga **provedor de envio**
(Resend/SES/Postmark). É mais uma credencial e mais uma decisão — está na §8.

---

## 4. O que será criado

### 4.1 Banco — só o necessário para esta fatia

`prisma/schema.prisma`, `provider = "mysql"`, `relationMode = "prisma"`,
`@default(cuid())`, sem `autoincrement()`, `@@index` explícito em toda FK.

| Model | Campos |
|---|---|
| `User` | `id`, `email` (unique), `emailVerifiedAt?`, `username` (unique), `displayName`, `avatarUrl?`, `passwordHash?`, `role`, `status`, `lastSeenAt?`, `createdAt`, `updatedAt`, `deletedAt?` |
| `OAuthAccount` | `id`, `userId`, `provider`, `providerAccountId`, `createdAt` — `@@unique([provider, providerAccountId])`, `@@index([userId])` |
| `RefreshToken` | `id`, `userId`, `tokenHash`, `expiresAt`, `revokedAt?`, `replacedById?`, `ip?`, `userAgent?`, `createdAt` — `@@index([userId])`, `@@index([expiresAt])` |
| `EmailToken` | `id`, `userId`, `tokenHash`, `purpose` (`VERIFY` \| `RESET`), `expiresAt`, `usedAt?` — `@@index([userId])` |
| `UserSettings` | 1:1 com `User`, criado junto no cadastro, nunca nulo |

`SystemLog` entra junto se você quiser rastro de login desde já; `AuditLog` fica
para a etapa do dashboard.

### 4.2 Serviço NestJS — `apps/api/`

Módulos desta fatia: `prisma`, `auth`, `users`, `mail`.

```
POST /auth/register           e-mail + senha, dispara verificação
POST /auth/login              e-mail + senha
GET  /auth/verify?token=      confirma e-mail
POST /auth/password/forgot    dispara reset
POST /auth/password/reset     troca a senha, revoga todos os refresh
GET  /auth/google             302 para o Google (state + PKCE em cookie httpOnly)
GET  /auth/google/callback    troca code, valida id_token, cria/vincula, 302 para a SPA
POST /auth/refresh            rotaciona o refresh, emite access novo
POST /auth/logout             revoga o refresh e limpa cookie
GET  /auth/me                 usuário do access token
```

**Tokens:**
- *Access*: JWT, ~15 min, no corpo da resposta → memória do cliente, nunca
  `localStorage` (XSS lê `localStorage`).
- *Refresh*: opaco, aleatório, **só o hash no banco**, cookie `httpOnly`
  `Secure` `SameSite=Lax`, rotativo — usar um revoga o anterior; reuso de token
  já rotacionado revoga a família inteira (detecção de roubo).
- `state` e `code_verifier` do PKCE em cookie httpOnly curto, para o callback
  não aceitar código de terceiro.

O `id_token` do Google é validado contra o JWKS dele, conferindo `aud`, `iss`,
`exp` e `email_verified` — não basta decodificar.

**Senha:** argon2id. Resposta de login e de "esqueci a senha" com tempo e texto
constantes, para não virar oráculo de quais e-mails existem.

**Guards:** `JwtAuthGuard` global via `APP_GUARD` com `@Public()` para abrir
exceção. Rota nova nasce **protegida**, que é exatamente o §5.3 do documento e o
motivo pelo qual NestJS vale o custo aqui.

**Algoritmo do JWT:** HS256 obriga a Vercel a ter o mesmo segredo do NestJS para
validar (§2.2). Prefiro **RS256/EdDSA**: a API assina com a privada, a função da
Vercel valida com a pública, e um vazamento no lado da Vercel não emite token.

### 4.3 Ligação com o que já existe

`api/token.ts` passa a aceitar `Authorization: Bearer` opcional:
- **com token válido**: `identity` = id do usuário (estável entre reconexões,
  hoje é UUID novo a cada emissão) e `name` = `displayName` da conta,
  ignorando o que o cliente mandou;
- **sem token**: comportamento atual, byte a byte.

É aqui que a autenticação vira valor: hoje o servidor assina um token afirmando
um nome que o próprio cliente inventou.

`api/rooms.ts` não muda.

---

## 5. Arquivos, por caminho

**Criados**
```
apps/api/                                  serviço NestJS (main, app.module, Dockerfile)
apps/api/src/prisma/…                      módulo + cliente
apps/api/src/auth/…                        controller, service, estratégias, guards,
                                           decorators @Public/@Roles, DTOs
apps/api/src/users/…
apps/api/src/mail/…                        envio de verificação e reset
apps/api/prisma/schema.prisma
apps/api/prisma/migrations/…               (gerado)
apps/api/test/auth.e2e-spec.ts             401/403 e rotação de refresh
apps/web/src/hooks/useAuth.tsx             AuthProvider + contexto
apps/web/src/components/RequireAuth.tsx
apps/web/src/pages/LoginPage.tsx
apps/web/src/lib/auth.ts                   chamadas à API, refresh transparente
```

**Alterados**
```
pnpm-workspace.yaml             + apps/api
package.json                    scripts do serviço novo
.env.example                    GOOGLE_*, JWT_*, DATABASE_URL, MAIL_*, APP_URL
.github/workflows/deploy.yml    build/test/deploy do apps/api
scripts/check-bundle.mjs        + GOOGLE_CLIENT_SECRET, JWT_PRIVATE_KEY no varredor
packages/shared/src/index.ts    tipos e validadores de auth
apps/web/src/main.tsx           envolve com AuthProvider
apps/web/src/App.tsx            rota /entrar
apps/web/src/pages/JoinPage.tsx botão do Google; nome vem da conta se logado
apps/web/src/lib/config.ts      URL da API
api/token.ts                    Bearer opcional (§4.3)
SPEC.md                         emenda §2.4 (auth) e revisão do §9
README.md                       Google Cloud, TiDB, provedor de e-mail, host da API
```

---

## 6. Riscos sobre o que já está no ar

| Risco | Gravidade | Contenção |
|---|---|---|
| Sem domínio próprio, cookie cross-site quebra o login no Safari | **alta** | domínio próprio com API em subdomínio (§2.1) |
| Mexer em `api/token.ts` quebrar quem entra hoje | **alta** | caminho sem Bearer sai idêntico; testar anônimo **e** logado antes de publicar |
| Vinculação indevida de conta Google ↔ senha | **alta** | regras da §3, com teste |
| `client_secret` ou chave privada vazando | alta | fluxo de code no servidor; guard de build estendido |
| Serviço novo cair e derrubar o app inteiro | média | auth é opcional: falha da API não pode impedir entrar em sala. Login degradado, sala funcionando |
| Deploy em dois lugares dessincronizar | média | workflow único, API antes da SPA |
| Segredo de JWT compartilhado entre Vercel e API | média | RS256/EdDSA: Vercel só tem a pública (§4.2) |
| Cold start / custo do host de processo | baixa | plano free onde couber; medir |

---

## 7. Critérios de aceite desta fatia

- [ ] `prisma migrate deploy` roda limpo contra TiDB Starter zerado
- [ ] Nenhum `autoincrement()`; toda FK com `@@index`
- [ ] Login com Google cria `User` + `OAuthAccount` + `UserSettings` numa transação
- [ ] Segundo login com o mesmo Google reaproveita a conta, não duplica
- [ ] Conta por senha com e-mail **não verificado** não é vinculada ao Google — com teste
- [ ] Refresh rotaciona; reusar refresh antigo revoga a família — com teste
- [ ] Rota protegida devolve 401 sem token, com token expirado e com assinatura inválida — com teste
- [ ] `USER` recebe 403 em rota marcada `@Roles(ADMIN)` — com teste
- [ ] `check-bundle` falha se `GOOGLE_CLIENT_SECRET` ou chave privada entrar no bundle
- [ ] Entrar numa sala **sem** login continua funcionando idêntico a hoje
- [ ] Entrar numa sala **com** login usa nome e identity da conta
- [ ] API fora do ar não impede entrar em sala
- [ ] `README` com Google Cloud Console, cluster TiDB, provedor de e-mail e host da API

---

## 8. O que ainda falta

Resolvido durante a implementação: host (Vercel, mesma origem), domínio próprio
(desnecessário), e o cluster TiDB, já criado.

1. **Provedor de e-mail** (§3). Enquanto `MAIL_DRIVER=log`, o link de
   confirmação é escrito no log em vez de enviado — serve para desenvolver, não
   para produção. Sem envio real, cadastro por senha não fecha com segurança:
   é a verificação de e-mail que sustenta a regra de vinculação da §3.
2. **OAuth Client no Google Cloud Console.** Sem ele o login social responde 503
   e o botão some da tela; o resto funciona.
3. **Verificar no primeiro deploy:** o empacotamento do motor do Prisma (§2.3) e
   a precedência de `api/token.ts` sobre a captura `api/[...nest].ts`.
