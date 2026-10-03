# syntax = docker/dockerfile:1

# Node runs server.ts directly (its type-stripping handles the plain
# annotations in it), so there's no separate build stage. The only
# dependencies are ws (WebSocket server) and marked (renders README.md for
# /readme/) --- persistence is node:sqlite, built into the runtime.
FROM node:24-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY server.ts stage.ts ./
COPY public ./public
COPY README.md ./

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.ts"]
