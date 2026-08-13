# Runbook — Phase B Scale (2 Instances)

**Preparation document** for operating when the project scales from **1 instance** to **2 NestJS instances** behind Nginx — **not yet implemented** until metrics trigger (section 2).

Related: [project-overview.md](../../../docs/project-overview.md) §10, [chat-rate-limit-quota.md](./chat-rate-limit-quota.md) §H7, [doppler-secrets.md](./doppler-secrets.md), `deploy/nginx/`.

---

## 1. Phase B Goals

| | |
|---|---|
| **Scale** | ~200–800 active students; peak chat hours (evenings, after announcements) |
| **Architecture** | 2 Nest containers + Nginx `upstream` + Redis + shared PostgreSQL |
| **No change** | Meta webhook URL, DB schema, logic in `src/` |
| **Reference VPS** | `69.62.74.196` — 2 vCPU, Redis already running (`~/redis`) |

**What scales:** many users messaging **simultaneously** → 2 pods handle webhook / chat flush in parallel.

**Still bottlenecked at:** OpenAI RPM/TPM (2 pods share API key); reminders >50 jobs due per loop (LLM sequential).

---

## 2. When to Deploy (Trigger)

**Don't** enable early just because it's prepared. Enable when **≥2** of these signs persist for several days:

| Metric | Suggested Threshold |
|--------|-------------------|
| Messenger process CPU | >50% during peak hours |
| Chat latency (webhook → reply) | p95 >25–30s (excluding quota-exceeded users) |
| OpenAI logs | 429 / timeouts increasing noticeably |
| Dead-letter webhook | Retries / backlog growing |

**Current status (reference):** 1 container ~50 MB RAM, CPU ~0% → **keep 1 instance**; this runbook is ready when needed.

Monitor before scaling:

```bash
npm run ops:health
docker stats messenger-bot --no-stream   # on VPS
```

---

## 3. Target Diagram

```text
Meta webhook
    → Nginx (aiassist.aihubproduction.com)
        → round-robin
            → messenger-bot-1  127.0.0.1:5007
            → messenger-bot-2  127.0.0.1:5008
                    ↓
            Redis (dedupe, queue, history)
            PostgreSQL (ai_chat_bot_db)
            OpenAI / Wispace API / Meta Send API
```

- **No** sticky sessions — each webhook goes to any pod.
- Chat state must live in **Redis + DB**, not single-pod RAM → `CHAT_QUEUE_SHARED=true` required.

---

## 4. Trade-offs — Benefits vs Costs

This section answers: **what does 2-instance scaling gain you, and what does it cost** — to decide if it's worth enabling when triggers are met (section 2).

### 4.1. Benefits

| Benefit | Explanation |
|---------|-------------|
| **Parallel webhook handling** | Many users messaging at once → Nginx splits requests between 2 pods; each pod flushes / calls LLM independently for different PSIDs. |
| **Reduces single-process overload risk** | CPU / event loop of **one** Node doesn't shoulder all peaks (evenings, after announcements). |
| **Smoother rolling deploys** | Can recreate pods one at a time; Nginx routes to surviving pod (when upstream config is correct). |
| **Enables proper multi-pod architecture** | Redis store already available — `CHAT_QUEUE_SHARED=true` is required so chat doesn't break when LB splits webhooks. |
| **Report cron has leader** | Only 1 pod runs 08:00 schedule; other pod focuses on webhooks. |

Benefits are **most clear** when **many PSIDs chat simultaneously** and **single-instance CPU** is the bottleneck — **not** when there are just "many registered students" who rarely message.

### 4.2. Costs / Trade-offs

| Trade-off | Details |
|-----------|---------|
| **Operational complexity** | 2 containers, 2 ports, Nginx upstream, env leader, dual health checks, more complex rollback than 1 pod. |
| **Doppler + Compose** | Shared `.env` insufficient — `INSTANCE_ID` override per service; easy to misconfigure leader. |
| **2 vCPU VPS shared** | 2 pods + Postgres + Redis + other services **compete for CPU** — not "double the power". |
| **RAM & DB connections** | ~2× app process footprint; ~2× TypeORM connection pool to PostgreSQL. |
| **Cron / loop runs twice** | Reminder adaptive dispatch: **both pods** poll DB (`claimJob` prevents duplicate sends, but **extra queries**). |
| **OpenAI doesn't double** | Same API key → **same RPM/TPM quota**; 2 pods may hit 429 **sooner** during LLM peaks. |
| **Single-user latency nearly unchanged** | Still debounce ~2s + LLM ~5–20s — **no** reduction in individual wait time. |
| **Mandatory Redis dependency** | `CHAT_QUEUE_SHARED=true` — Redis down impacts multi-pod chat more heavily than single-instance mode (RAM-local debounce). |
| **Harder debugging** | Logs across 2 containers; webhooks hit random pod — need `INSTANCE_ID` in logs when investigating. |
| **Deployment cost** | PR compose + nginx + deploy script + cutover + 48h monitoring. |

### 4.3. Still Not Solved (Even with 2 Instances)

| Problem | Notes |
|---------|-------|
| OpenAI slow / 429 | Upgrade API tier; **`LlmExecutionService`** (`LLM_MAX_CONCURRENT`, retry) ✓ — multi-pod needs Redis gate later |
| >50 reminders due in same minute | Still sequential LLM, `LIMIT 50`/dispatch loop |
| 30-minute full-scan sync cron | Load increases with user count; advisory lock — doesn't scale by adding chat pods |
| Meta Send API | Almost never a bottleneck at IELTS student scale |

### 4.4. Quick Comparison

| | 1 Instance | 2 Instances (Phase B) |
|---|-------------|------------------------|
| Concurrent webhooks | Limited by 1 CPU / 1 event loop | Better (2 event loops) |
| Single-user latency | ~2s debounce + LLM | **Nearly identical** |
| Ops complexity | Low | Higher |
| OpenAI pressure | 1 stream | 2 streams → easier 429 at peak |
| Machine cost | Low | Higher (~2 processes) |
| Best when | Low load (current prod) | CPU/webhook peak, peak chat hours |

### 4.5. Practical Conclusion

**Gains:** ability to **split concurrent HTTP / chat** and **CPU headroom** during peaks.

**Pays for:** **operational complexity**, **Redis dependency**, **~2× process resources**, **no** improvement in per-user LLM latency or doubled OpenAI quota.

On a **2-core** VPS with **~0% CPU** load (prod reference) → benefits are **near zero**, only costs — **keep 1 instance** until section 2 metrics hit threshold.

**Lighter alternatives before scaling:** upgrade OpenAI tier, monitor `npm run ops:health`, avoid deploying during peak hours — sometimes sufficient without needing a second pod.

---

## 5. Prerequisites (Pre-Cutover Checklist)

- [ ] Redis stable: `curl -sf http://127.0.0.1:5007/health/ready` → `{"status":"ok"}` (fails while Redis configured but unreachable)
- [ ] Prod has: `REDIS_ENABLED=true`, `CHAT_QUEUE_STORE=redis`, `CHAT_HISTORY_STORE=redis`; webhook delivery dedupe is handled by the durable `webhook_inbound_events` inbox (there is no `CHAT_DEDUPE_STORE`)
- [ ] `CHAT_RATE_LIMIT_ENABLED=true`, `ENFORCE_PROD_CHAT_QUOTA=true`
- [ ] Backup `.env` / Doppler config `prd` (snapshot before change)
- [ ] Deploy window: **outside peak chat hours** (avoid evenings after announcements)
- [ ] `sudo` access on VPS for `nginx -t && systemctl reload nginx`

---

## 6. Environment Variables

### 6.1. Shared (`.env` / Doppler `prd` — **same** on both pods)

Add or change when scaling:

```env
CHAT_QUEUE_SHARED=true

CRON_LEADER_ENABLED=true
```

Keep unchanged (already in prod):

```env
REDIS_ENABLED=true
REDIS_HOST=172.24.0.1
REDIS_PRIVATE_NETWORK=true
REDIS_TLS=false
CHAT_QUEUE_STORE=redis
CHAT_HISTORY_STORE=redis
CHAT_RATE_LIMIT_ENABLED=true
```

**Don't** set `INSTANCE_ID` in Doppler if using shared config — it will be identical on both pods (see 6.2).

### 6.2. Per-Pod Override (Docker Compose — **Required**)

| Pod | `INSTANCE_ID` | `PORT` (inside container) | Bind Host |
|-----|---------------|--------------------------|-----------|
| `messenger-bot-1` | `messenger-bot-1` | `5007` | `127.0.0.1:5007` |
| `messenger-bot-2` | `messenger-bot-2` | `5008` | `127.0.0.1:5008` |

### 6.3. Cron Leader — Lease-Based Election

Leader election is now lease-based (`cron_leader_leases` table): `CRON_LEADER_ENABLED=true` makes every pod race for a lease keyed by `INSTANCE_ID`; the current leader heartbeats it every minute, and any pod takes over ≤3 min after the leader dies. No static `CRON_LEADER_INSTANCE_ID` — identity is `INSTANCE_ID`/hostname.

| Variable | Pod 1 | Pod 2 |
|----------|-------|-------|
| `CRON_LEADER_ENABLED` | `true` | `true` |
| `INSTANCE_ID` | `messenger-bot-1` | `messenger-bot-2` (**different**) |

→ Exactly one pod runs **08:00 report cron** and **`*/15` retry dispatch** at a time; the other takes over automatically if the leader dies.

**Warning:** leaving `CRON_LEADER_ENABLED=false` (default) means **both pods** run cron — the R4 advisory lock/claim still prevents duplicates but wastes resources.

### 6.4. Doppler

- Shared secrets: `CHAT_QUEUE_SHARED`, `CRON_LEADER_ENABLED` — upload to `prd` config.
- `INSTANCE_ID` / pod 2 port: **don't** put in shared Doppler — override in `docker-compose` per service.
- After changing Doppler: run the manual **Sync production env** workflow. Bot containers do not receive the host Docker socket.

---

## 7. Infrastructure Changes (When Implementing — Reference)

> This section describes **what will be done**; repo files **not yet changed** until team decides to implement.

### 7.1. Docker Compose

Current (`docker-compose.prod.yml`): single service, fixed `container_name: messenger-bot` → **can't** scale.

Target: two services `messenger-bot-1` / `messenger-bot-2`, no fixed `container_name`, each service with its own host port.

Concept:

```yaml
services:
  messenger-bot-1:
    image: ${IMAGE}
    env_file: .env
    environment:
      INSTANCE_ID: messenger-bot-1
      PORT: "5007"
    ports:
      - "127.0.0.1:5007:5007"
    # no host mounts or Docker socket; run as the unprivileged image user

  messenger-bot-2:
    image: ${IMAGE}
    env_file: .env
    environment:
      INSTANCE_ID: messenger-bot-2
      PORT: "5008"
    ports:
      - "127.0.0.1:5008:5008"
```

VPS deploy path: `/home/ngoc_anh/messenger-bot/`.

### 7.2. Nginx

File: `/etc/nginx/sites-available/aiassist.aihubproduction.com` (repo: `deploy/nginx/aiassist.aihubproduction.com.conf`).

Add `upstream` and change `proxy_pass`:

```nginx
upstream messenger_bot {
    server 127.0.0.1:5007;
    server 127.0.0.1:5008;
}

location = /webhook {
    proxy_pass http://messenger_bot;
    # keep client_max_body_size, limit_req, headers as before
}

location / {
    proxy_pass http://messenger_bot;
    # keep headers as before
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 7.3. Deploy Script (`.github/scripts/vps-deploy.sh`)

Needs expansion for real implementation:

- Health check **both** `:5007` and `:5008` (`/health/ready`; detailed DB/Redis status via internal `/health/detail` with `X-Internal-Api-Key`)
- `docker compose ps` — 2 services healthy
- Log tail both containers

---

## 8. Per-Flow Behavior After Scale

| Flow | 2 Instances |
|------|-------------|
| Chat text | Webhook → any pod → Redis buffer (`CHAT_QUEUE_SHARED`) → worker poll 2s flush |
| `mid` dedupe | Durable PostgreSQL `webhook_inbound_events` inbox — cross-pod |
| Daily quota | PostgreSQL atomic (H3) |
| 08:00 reports | Only leader `INSTANCE_ID=messenger-bot-1` |
| Report retry `*/15` | Only leader |
| Reminder dispatch | **Both pods** adaptive loop; `claimJob` — no duplicates |
| 30-min study sync | Advisory lock — 1 pod/run |
| Evening rollover / cleanup | Advisory lock — 1 pod/run |
| Dead-letter webhook 5-min | Advisory lock — 1 pod/run |

---

## 9. Deployment Process (Draft)

### 9.1. Pre-Cutover

1. Snapshot Doppler `prd` + backup `~/messenger-bot/.env`
2. Merge ops PR (compose + nginx + deploy script) — when code is ready
3. Set Doppler: `CHAT_QUEUE_SHARED=true`, `CRON_LEADER_ENABLED=true`
4. Deploy new image + compose 2 services
5. Update Nginx upstream → `nginx -t` → reload

### 9.2. Post-Cutover (15–30 minutes)

```bash
# Health per pod (readiness; detail via internal /health/detail + X-Internal-Api-Key)
curl -sf http://127.0.0.1:5007/health/ready
curl -sf http://127.0.0.1:5008/health/ready

# Through Nginx
curl -sf https://aiassist.aihubproduction.com/health/ready

# Leader
docker logs messenger-bot-2 2>&1 | tail -50 | grep -i "Report cron skipped" || true

# Manual chat: send Messenger → bot replies; quota increases
npm run chat-quota:status -- --psid=<PSID>
```

Monitor for **48h**: CPU, RAM, `npm run ops:health`, OpenAI 429 logs, dead-letter.

### 9.3. Rollback

1. Nginx: `proxy_pass` back to only `127.0.0.1:5007`
2. `docker compose stop messenger-bot-2` (or `up` single service)
3. `.env`: `CHAT_QUEUE_SHARED=false` (optional, back to 1 pod)
4. `CRON_LEADER_ENABLED=false`
5. Reload nginx + recreate pod 1

If chat breaks after rollback: check Redis key prefix `chat:*` (only flush when impact is understood).

---

## 10. Phase B Limits (Manage Expectations)

| Problem | Phase B | Future Direction |
|---------|---------|-----------------|
| OpenAI 429 at peak | May still occur | Upgrade API tier; increase `LLM_MAX_CONCURRENT` or Redis gate with 2 pods |
| >50 reminders due same minute | Reminders delayed a few minutes | Delayed queue / parallel workers (roadmap) |
| 30-min full-scan sync | Load increases with users | WISPACE wire sync API (already done) |
| VPS 2 cores maxed out | Shouldn't add pod 3 | Upgrade to 4 vCPU or separate VPS for messenger |

---

## 11. 1 vs 2 Instances Comparison (Current Prod)

| | 1 Instance (Current) | 2 Instances (Phase B) |
|---|----------------------|------------------------|
| `CHAT_QUEUE_SHARED` | `false` | `true` |
| `CRON_LEADER_ENABLED` | `false` | `true` |
| Nginx | 1 backend `:5007` | `upstream` 5007 + 5008 |
| Container | `messenger-bot` | `messenger-bot-1`, `messenger-bot-2` |
| When | Low load | Section 2 trigger |

Trade-off details: section 4.

---

## 12. Post-Implementation Tasks (Not in This Runbook Step)

When team decides to implement, ops-only PR includes:

1. `docker-compose.prod.yml` — 2 services + `INSTANCE_ID` override
2. `deploy/nginx/aiassist.aihubproduction.com.conf` — `upstream`
3. `.github/scripts/vps-deploy.sh` — health check 2 ports
4. `.env.example` — comment `CHAT_QUEUE_SHARED` + `CRON_LEADER_*` for scaling
5. Tick checklist in section 5 of this runbook

**No** `src/` changes needed for basic Phase B scaling.

---

*Preparation runbook — not yet deployed to production. Update the date when actual cutover is performed.*
