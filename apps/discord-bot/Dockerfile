# syntax=docker/dockerfile:1
# Build context: repo root (needs access to shared packages)
# docker build -f apps/discord-bot/Dockerfile .

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/discord-bot/package.json apps/discord-bot/package.json
COPY packages/llm-agent/package.json packages/llm-agent/package.json
COPY packages/chat-metering/package.json packages/chat-metering/package.json
COPY packages/chat-history/package.json packages/chat-history/package.json
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
RUN npx turbo run build --filter=@wispace/discord-bot... && rm -f package-lock.json && npm install --force --omit=dev --ignore-scripts

FROM node:20-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup -g 1001 -S app \
  && adduser -S app -u 1001 -G app

COPY --from=build --chown=app:app /app/apps/discord-bot/dist ./dist
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/apps/discord-bot/package.json ./package.json
# node_modules/@wispace/* are npm-workspaces symlinks into packages/ —
# each package must exist at the same relative path for Node to resolve them at runtime.
COPY --from=build --chown=app:app /app/packages/llm-agent ./packages/llm-agent
COPY --from=build --chown=app:app /app/packages/chat-metering ./packages/chat-metering
COPY --from=build --chown=app:app /app/packages/chat-history ./packages/chat-history
COPY --from=build --chown=app:app /app/packages/chat-pipeline ./packages/chat-pipeline
COPY --from=build --chown=app:app /app/packages/chat-queue-core ./packages/chat-queue-core
COPY --from=build --chown=app:app /app/packages/wispace-client ./packages/wispace-client
COPY --from=build --chown=app:app /app/packages/student-report ./packages/student-report
COPY --from=build --chown=app:app /app/packages/study-reminder-core ./packages/study-reminder-core
COPY --from=build --chown=app:app /app/packages/study-reminder-shared ./packages/study-reminder-shared
COPY --from=build --chown=app:app /app/packages/scheduler-core ./packages/scheduler-core
COPY --from=build --chown=app:app /app/packages/bot-metrics ./packages/bot-metrics
COPY --from=build --chown=app:app /app/packages/cleanup-cron ./packages/cleanup-cron
COPY --from=build --chown=app:app /app/packages/ops-health ./packages/ops-health
COPY --from=build --chown=app:app /app/packages/reschedule-confirm ./packages/reschedule-confirm

RUN npm install --force --omit=dev --ignore-scripts

USER app

EXPOSE 3001

CMD ["node", "dist/main.js"]
