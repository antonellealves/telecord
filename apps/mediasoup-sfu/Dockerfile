# Imagem do processo mediasoup-sfu.
#
# Mesmo desenho multi-estágio de apps/api/Dockerfile: build com o compilador,
# runtime sem ele. Builda com CONTEXTO NA RAIZ do monorepo (ver
# docker-compose.prod.yml e docker-compose.yml, `context: .`), porque o
# pacote depende de @telecord/shared via workspace.
#
# `mediasoup` baixa um binário nativo prebuilt (worker em C++) no postinstall
# — ver package.json. A imagem final precisa ser Linux glibc compatível com o
# que o pacote publica; `node:22-slim` é Debian, o alvo suportado (mesma base
# de apps/api/Dockerfile).
#
# ## Por que a raiz do monorepo é "esvaziada" aqui
#
# O package.json da RAIZ tem `dependencies` de runtime — `@telecord/api`,
# `livekit-server-sdk`, `jose`, `ws` —, porque as funções da Vercel moram em
# `api/` e resolvem a partir dela. E o pnpm SEMPRE instala a raiz junto, com
# ou sem `--filter`: o SFU levava a API inteira de carona (Prisma com os
# engines, Nest, rxjs, effect…), ~250 MB de node_modules para um processo que
# só usa `mediasoup` e `socket.io`. Na VM de ~500 MB de RAM, só o
# `COPY --from=build /app/node_modules` passava dos 20 minutos do deploy.
#
# Tirar as `dependencies` da raiz SÓ DENTRO da imagem resolve. O lockfile
# deixa de bater com a raiz, por isso `--no-frozen-lockfile`: o pnpm
# re-resolve apenas o importer da raiz (que ficou só com devDependencies) e
# mantém as versões travadas de tudo que o SFU usa — o grafo do SFU não muda.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
# Só os manifests do SFU e do que ele importa: mudar dependência do front ou
# da API não invalida mais o cache desta camada.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/mediasoup-sfu/package.json apps/mediasoup-sfu/
COPY packages/shared/package.json packages/shared/
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.dependencies;fs.writeFileSync('package.json',JSON.stringify(p,null,2))"
# `--ignore-scripts`: o tsc não precisa do worker nativo. Ele é baixado uma
# vez só, no `pnpm deploy` do estágio de build.
RUN pnpm install --no-frozen-lockfile --prefer-offline --ignore-scripts --filter @telecord/mediasoup-sfu...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/mediasoup-sfu apps/mediasoup-sfu
RUN pnpm --filter @telecord/shared build && pnpm --filter @telecord/mediasoup-sfu build
# Pasta autocontida com o `dist` e só as dependências de PRODUÇÃO (~35 MB):
# sem typescript, sem @types e com @telecord/shared copiado no lugar do link.
RUN pnpm --filter @telecord/mediasoup-sfu deploy --prod /prod

# Runtime sem pnpm nem corepack: só o node e a pasta do deploy.
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /prod ./

# NÃO roda como `node` (usuário sem-privilégio de apps/api/Dockerfile): o
# worker nativo do mediasoup precisa abrir a faixa de portas UDP/RTC, e em
# alguns runtimes de container isso exige capacidade que o usuário `node` não
# tem por padrão. Mesmo trade-off que o próprio livekit-server aceita.
EXPOSE 3100
CMD ["node", "dist/src/main.js"]
