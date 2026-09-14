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
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/mediasoup-sfu/package.json apps/mediasoup-sfu/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
# Só o que este serviço precisa — instalar o workspace inteiro aqui baixaria
# o SDK do LiveKit e o React para rodar um SFU de áudio/vídeo.
RUN pnpm install --frozen-lockfile --filter @telecord/mediasoup-sfu...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/mediasoup-sfu apps/mediasoup-sfu
RUN pnpm --filter @telecord/shared build && pnpm --filter @telecord/mediasoup-sfu build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/apps/mediasoup-sfu/node_modules apps/mediasoup-sfu/node_modules
COPY --from=build /app/apps/mediasoup-sfu/package.json apps/mediasoup-sfu/package.json
COPY --from=build /app/apps/mediasoup-sfu/dist apps/mediasoup-sfu/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist

# NÃO roda como `node` (usuário sem-privilégio de apps/api/Dockerfile): o
# worker nativo do mediasoup precisa abrir a faixa de portas UDP/RTC, e em
# alguns runtimes de container isso exige capacidade que o usuário `node` não
# tem por padrão. Mesmo trade-off que o próprio livekit-server aceita.
EXPOSE 3100
CMD ["node", "apps/mediasoup-sfu/dist/src/main.js"]
