# PlayOn control-plane image (panel only — no Docker socket required).
# Pair with a host-native local-node for SteamCMD / native games.
# Optional: see deploy/docker-compose.yml
FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
COPY skills ./skills
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @playon/shared --filter @playon/runtime --filter @playon/agent-core --filter @playon/server-query --filter @playon/api --filter @playon/web build

FROM node:22-bookworm-slim AS runtime
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate \
  && apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/playon
COPY --from=build /src /opt/playon
ENV PLAYON_ENV=production \
    PLAYON_HOST=0.0.0.0 \
    PLAYON_PORT=8787 \
    PLAYON_RUNTIME=native \
    PLAYON_PACKAGES_ROOT=/opt/playon/packages \
    PLAYON_SKILLS_PROFILE=minimal \
    PLAYON_WEB_DIST=/opt/playon/apps/web/dist \
    PLAYON_DATA_ROOT=/var/lib/playon
EXPOSE 8787
CMD ["pnpm", "--filter", "@playon/api", "start"]
