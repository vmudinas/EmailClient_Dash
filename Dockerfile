FROM node:22-bookworm-slim AS web-build

WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --workspace @email-client/shared --workspace @email-client/web --include-workspace-root
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @email-client/shared && npm run build -w @email-client/web

FROM mcr.microsoft.com/dotnet/sdk:10.0-noble AS api-build

WORKDIR /src
COPY apps/api-dotnet/ArchiveMail.Api/ArchiveMail.Api.csproj apps/api-dotnet/ArchiveMail.Api/
RUN dotnet restore apps/api-dotnet/ArchiveMail.Api/ArchiveMail.Api.csproj
COPY apps/api-dotnet/ArchiveMail.Api apps/api-dotnet/ArchiveMail.Api
RUN dotnet publish apps/api-dotnet/ArchiveMail.Api/ArchiveMail.Api.csproj \
    --configuration Release --no-restore --output /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0-noble AS runtime

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg pst-utils \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client-17 \
  && rm -rf /var/lib/apt/lists/*

ENV ASPNETCORE_URLS=http://0.0.0.0:3001 \
    ASPNETCORE_ENVIRONMENT=Production \
    EMAIL_CLIENT_DATA_DIR=/data \
    DOTNET_GCServer=1 \
    DOTNET_EnableDiagnostics=0

COPY --from=api-build /out ./
COPY --from=web-build /src/apps/web/dist ./wwwroot
RUN mkdir -p /data/incoming /data/import-staging /data/blobs \
  && chown -R 1000:1000 /data

USER 1000:1000
VOLUME ["/data"]
EXPOSE 3001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=5 \
  CMD ["curl", "--fail", "--silent", "http://127.0.0.1:3001/api/health"]
ENTRYPOINT ["dotnet", "ArchiveMail.Api.dll"]
