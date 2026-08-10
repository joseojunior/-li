FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY apps ./apps
COPY scripts ./scripts
RUN npm run build --workspace @lilibag/api && npm run build --workspace @lilibag/web
RUN npm prune --omit=dev

FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
# SQL migrations are loaded at runtime by the migration command.
COPY --from=build /app/apps/api/src/db/migrations ./apps/api/dist/db/migrations
RUN addgroup -S lilibag && adduser -S lilibag -G lilibag
USER lilibag
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]

FROM api AS worker
CMD ["node", "apps/api/dist/worker.js"]

FROM caddy:2.10-alpine AS web
COPY --from=build /app/apps/web/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile

# Used behind the existing Traefik Swarm service. TLS is terminated by Traefik,
# so this container serves only internal HTTP on port 80.
FROM caddy:2.10-alpine AS web-swarm
COPY --from=build /app/apps/web/dist /srv
COPY deploy/Caddyfile.swarm /etc/caddy/Caddyfile
