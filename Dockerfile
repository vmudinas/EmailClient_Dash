# Builds only what the server needs to run: @email-client/shared, @email-client/api,
# and the static @email-client/web build. apps/desktop (Electron) is never built or
# copied into the runtime image — it isn't part of a headless server deployment.

FROM node:22-bookworm-slim AS build
WORKDIR /app

# Install with the full workspace lockfile so `npm ci` stays reproducible and matches
# what CI/local dev installs. This does pull in apps/desktop's devDependencies
# (Electron) during this stage, but the runtime stage below never copies them.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
RUN npm ci

COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build -w @email-client/shared \
 && npm run build -w @email-client/api \
 && npm run build -w @email-client/web

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/start.mjs ./start.mjs
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

EXPOSE 3001
CMD ["node", "start.mjs"]
