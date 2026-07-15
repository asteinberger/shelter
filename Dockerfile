FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS build

WORKDIR /app
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY apps/server apps/server
COPY apps/web apps/web
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts

FROM node:26-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66 AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7080 \
    DATA_DIR=/data \
    WEB_DIST=/app/apps/web/dist

RUN apk add --no-cache ca-certificates chromium docker-cli docker-cli-buildx git tini
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "apps/server/dist/index.js", "api"]
