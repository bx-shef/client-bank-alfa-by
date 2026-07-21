FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
# --frozen-lockfile: install exactly the committed lockfile (reproducible image,
# same as CI). --ignore-scripts: skip postinstall (`nuxt prepare`) — `nuxt
# generate` runs prepare itself in the builder stage.
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS builder
WORKDIR /app
COPY . .
# Author shown in the landing footer (runtimeConfig.public.author*). Optional —
# falls back to the defaults baked into nuxt.config.ts when unset.
ARG NUXT_PUBLIC_AUTHOR_NAME
ENV NUXT_PUBLIC_AUTHOR_NAME=$NUXT_PUBLIC_AUTHOR_NAME
ARG NUXT_PUBLIC_AUTHOR_URL
ENV NUXT_PUBLIC_AUTHOR_URL=$NUXT_PUBLIC_AUTHOR_URL
# Public URL the app is served from — used by the Bitrix24 install handler to
# build absolute placement URLs (needed once placement.bind lands). Optional now.
ARG NUXT_PUBLIC_SITE_URL
ENV NUXT_PUBLIC_SITE_URL=$NUXT_PUBLIC_SITE_URL
# Git commit of this build — footer links to it. CI passes ${{ github.sha }}.
ARG NUXT_PUBLIC_COMMIT_SHA
ENV NUXT_PUBLIC_COMMIT_SHA=$NUXT_PUBLIC_COMMIT_SHA
RUN pnpm generate
# Inject per-build sha256 CSP hashes for Nuxt's inline scripts into nginx.conf,
# so the served CSP needs no `script-src 'unsafe-inline'`. Writes in place.
RUN node scripts/csp-hashes.mjs .output/public nginx.conf nginx.conf

# --- Backend (separate service): Node server with the B24 webhook endpoint
# (/api/b24/events) + portal token store. Built from the SAME codebase via
# `nuxt build` (node-server preset), so it reuses the domain core. The static
# landing below is unaffected. Built only with `--target backend` (docker-compose);
# NOT the default stage — see the `runner` note. See docs/B24_EVENTS.md / docs/DEPLOY.md.
FROM deps AS builder-server
WORKDIR /app
COPY . .
ARG NUXT_PUBLIC_SITE_URL
ENV NUXT_PUBLIC_SITE_URL=$NUXT_PUBLIC_SITE_URL
# Declared (same as the static `builder` stage) so the CI deploy can pass the same
# build-args to both matrix targets without an "unused ARG" warning; the Nitro
# server would use them if it ever rendered the author footer.
ARG NUXT_PUBLIC_AUTHOR_NAME
ENV NUXT_PUBLIC_AUTHOR_NAME=$NUXT_PUBLIC_AUTHOR_NAME
ARG NUXT_PUBLIC_AUTHOR_URL
ENV NUXT_PUBLIC_AUTHOR_URL=$NUXT_PUBLIC_AUTHOR_URL
ARG NUXT_PUBLIC_COMMIT_SHA
ENV NUXT_PUBLIC_COMMIT_SHA=$NUXT_PUBLIC_COMMIT_SHA
RUN pnpm build

FROM node:22-alpine AS backend
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Nitro resolves `runtimeConfig.public.commitSha` from env at RUNTIME (unlike the
# static frontend, which bakes it into __NUXT__.config at generate time). So the
# final backend image must carry NUXT_PUBLIC_COMMIT_SHA, or /api/health + the footer
# fall back to 'dev' (#76). The build-arg already reaches this target from CI.
ARG NUXT_PUBLIC_COMMIT_SHA
ENV NUXT_PUBLIC_COMMIT_SHA=$NUXT_PUBLIC_COMMIT_SHA
# Nitro's node-server output is self-contained (deps bundled) — copy only .output.
COPY --from=builder-server /app/.output ./.output
# OTel bootstrap (#78): loaded via NODE_OPTIONS=--import BEFORE the app so auto-instrumentation
# can hook http/pg/ioredis at module load. Its deps must live OUTSIDE the Nitro bundle (the
# bundler breaks OTel's require hooks), so install just this small set here. Fully INERT unless
# OTEL_EXPORTER_OTLP_ENDPOINT is set (the file no-ops), so the default deploy is unchanged.
COPY otel.instrument.mjs /app/otel.instrument.mjs
COPY otel-preload-package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
# Absolute path: --import resolves relative to CWD, so an absolute path stays correct
# regardless of where node is launched from in the container.
# Quote the value: the ENV KEY=VALUE form treats a space as a second var separator, so the
# `--import <path>` value MUST be quoted or Docker errors ("can't find = in <path>").
ENV NODE_OPTIONS="--import /app/otel.instrument.mjs"
# Drop root: the node:alpine image ships an unprivileged `node` user (uid 1000). All build
# steps above ran as root (npm install, COPY); the runtime only READS world-readable /app and
# binds PORT 3000 (>1024, no privilege needed), so the server runs fine as `node`. Defense in
# depth — a code-exec bug in Nitro or a dependency no longer lands with root in the container.
USER node
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]

# nginx-unprivileged runs as the non-root `nginx` user and listens on :8080.
# MUST stay the LAST stage: it is the default `docker build` target, so the GHCR
# deploy (.github/workflows/ci.yml, no explicit --target) publishes the LANDING
# image, not the backend. CI also pins `target: runner` for clarity.
FROM nginxinc/nginx-unprivileged:1.31-alpine AS runner
COPY --from=builder /app/.output/public /usr/share/nginx/html
COPY --from=builder /app/nginx.conf /etc/nginx/conf.d/default.conf
# Shared backend-proxy directives, included by both /api/ locations (#100).
# `include snippets/proxy-backend.conf;` resolves relative to the nginx prefix (/etc/nginx).
COPY --from=builder /app/snippets/proxy-backend.conf /etc/nginx/snippets/proxy-backend.conf
# Validate the FINAL config (CSP hashes already substituted in the builder stage)
# at build time, so a syntax error fails the image build / PR docker-build instead
# of surfacing only at deploy (#99). `proxy_pass $backend_upstream` + resolver defer
# DNS to request time, so `nginx -t` needs no running backend.
RUN nginx -t
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
