# syntax=docker/dockerfile:1
# Build context: repo root (needs access to shared packages)
# docker build -f apps/zalo-bot/Dockerfile .

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/zalo-bot/package.json apps/zalo-bot/package.json
COPY packages/llm-agent/package.json packages/llm-agent/package.json
COPY packages/chat-history/package.json packages/chat-history/package.json
RUN npm ci --ignore-scripts

COPY . .
RUN npx turbo run build --filter=@wispace/zalo-bot... && npm ci --omit=dev --ignore-scripts

FROM node:20-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -g 1001 -S app \
  && adduser -S app -u 1001 -G app

COPY --from=build --chown=app:app /app/apps/zalo-bot/dist ./dist
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/apps/zalo-bot/package.json ./package.json
# node_modules/@wispace/* are npm-workspaces symlinks into packages/ —
# each package must exist at the same relative path for Node to resolve them at runtime.
COPY --from=build --chown=app:app /app/packages/llm-agent ./packages/llm-agent
COPY --from=build --chown=app:app /app/packages/chat-history ./packages/chat-history

USER app

EXPOSE 3002

CMD ["node", "dist/main.js"]
