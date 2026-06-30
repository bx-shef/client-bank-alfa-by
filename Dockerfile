FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY package.json ./
# Copy lock file when available for reproducible installs
COPY pnpm-lock.yaml* ./
RUN pnpm install --ignore-scripts

FROM deps AS builder
WORKDIR /app
COPY . .
# Author shown in the landing footer (runtimeConfig.public.author*). Optional —
# falls back to the defaults baked into nuxt.config.ts when unset.
ARG NUXT_PUBLIC_AUTHOR_NAME
ENV NUXT_PUBLIC_AUTHOR_NAME=$NUXT_PUBLIC_AUTHOR_NAME
ARG NUXT_PUBLIC_AUTHOR_URL
ENV NUXT_PUBLIC_AUTHOR_URL=$NUXT_PUBLIC_AUTHOR_URL
RUN pnpm generate
# Inject per-build sha256 CSP hashes for Nuxt's inline scripts into nginx.conf,
# so the served CSP needs no `script-src 'unsafe-inline'`. Writes in place.
RUN node scripts/csp-hashes.mjs .output/public nginx.conf nginx.conf

# nginx-unprivileged runs as the non-root `nginx` user and listens on :8080.
FROM nginxinc/nginx-unprivileged:1.31-alpine AS runner
COPY --from=builder /app/.output/public /usr/share/nginx/html
COPY --from=builder /app/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
