# syntax=docker/dockerfile:1
# Build context: repo root (needs access to shared packages)
# docker build -f apps/zalo-bot/Dockerfile .

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/zalo-bot/package.json apps/zalo-bot/package.json
COPY packages/llm-agent/package.json packages/llm-agent/package.json
COPY packages/chat-history/package.json packages/chat-history/package.json
COPY packages/chat-metering/package.json packages/chat-metering/package.json
COPY packages/chat-pipeline/package.json packages/chat-pipeline/package.json
COPY packages/chat-queue-core/package.json packages/chat-queue-core/package.json
COPY packages/wispace-client/package.json packages/wispace-client/package.json
COPY packages/student-report/package.json packages/student-report/package.json
COPY packages/study-reminder-core/package.json packages/study-reminder-core/package.json
COPY packages/study-reminder-shared/package.json packages/study-reminder-shared/package.json
COPY packages/scheduler-core/package.json packages/scheduler-core/package.json
COPY packages/bot-metrics/package.json packages/bot-metrics/package.json
COPY packages/cleanup-cron/package.json packages/cleanup-cron/package.json
COPY packages/ops-health/package.json packages/ops-health/package.json
COPY packages/reschedule-confirm/package.json packages/reschedule-confirm/package.json
RUN rm -f package-lock.json && npm install --force --ignore-scripts

COPY . .
RUN npx turbo run build --filter=@wispace/zalo-bot...

FROM node:20-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -g 1001 -S app \
  && adduser -S app -u 1001 -G app

# Copy built app
COPY --from=build --chown=app:app /app/apps/zalo-bot/dist ./apps/zalo-bot/dist
# Copy node_modules (preserves workspace symlinks)
COPY --from=build --chown=app:app /app/node_modules ./node_modules
# Copy built packages (symlink targets)
COPY --from=build --chown=app:app /app/packages ./packages

USER app

EXPOSE 3002

CMD ["node", "apps/zalo-bot/dist/main.js"]
