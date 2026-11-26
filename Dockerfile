# On-prem image: Next.js standalone server + SQL migrations + endpoint agent scripts.
# Build:  docker build -t itsm-platform:0.1.0 .
# Air-gapped sites: docker save itsm-platform:0.1.0 postgres:17-alpine | gzip > itsm-images.tar.gz
#                   then on the site: docker load < itsm-images.tar.gz

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    STORAGE_DIR=/data/files \
    MIGRATIONS_DIR=/app/db/migrations \
    LICENSE_PUBLIC_KEY_FILE=/app/keys/license-public.pem
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data/files /app/keys && chown -R app:app /data /app/keys
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --chown=app:app db/migrations ./db/migrations
COPY --chown=app:app agent ./agent
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "server.js"]
