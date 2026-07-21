FROM node:22-bookworm-slim AS workspace

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json start.mjs ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json

FROM workspace AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm ci \
  --workspace @email-client/shared \
  --workspace @email-client/api \
  --workspace @email-client/web \
  --include-workspace-root

COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web

RUN npm run build -w @email-client/shared \
  && npm run build -w @email-client/api \
  && npm run build -w @email-client/web

FROM workspace AS production-dependencies

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev \
  --workspace @email-client/shared \
  --workspace @email-client/api \
  --include-workspace-root \
  && npm cache clean --force

FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="Archive Mail"
LABEL org.opencontainers.image.description="Self-hosted email archive, Gmail sync, calendar, drafts, and AI workflows"

WORKDIR /app

ENV NODE_ENV=production \
  EMAIL_CLIENT_HOST=0.0.0.0 \
  EMAIL_CLIENT_PORT=3001 \
  EMAIL_CLIENT_DATA_DIR=/data \
  EMAIL_CLIENT_WEB_DIR=/app/apps/web/dist

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/start.mjs ./
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/property-assets ./apps/api/property-assets
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY deploy/scripts/migrate-sqlite-to-postgres.mjs ./deploy/scripts/migrate-sqlite-to-postgres.mjs

RUN mkdir -p /data && chown node:node /data

USER node

VOLUME ["/data"]
EXPOSE 3001
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/api/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "start.mjs"]
