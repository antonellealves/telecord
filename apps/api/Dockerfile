# Imagem do serviço de autenticação.
#
# Multi-estágio para a imagem final não carregar o compilador nem as
# dependências de build. O mesmo Dockerfile serve o desenvolvimento local
# (docker-compose.yml, com a fonte montada por cima) e o deploy em qualquer
# host de processo — Fly, Railway, Render.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# OpenSSL: o motor de query do Prisma liga contra ele e a imagem slim não traz.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
# Dependências. Só os manifestos primeiro: enquanto eles não mudarem, o cache
# desta camada sobrevive a qualquer alteração de código.
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @telecord/api...

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
# O contrato compartilhado primeiro: o serviço o consome pelo node_modules, e
# `tsc` precisa dos tipos já emitidos.
RUN pnpm --filter @telecord/shared build  && pnpm --filter @telecord/api build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist

# Não roda como root: um furo no processo não deve virar root no contêiner.
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/src/main.js"]
