# Codebase Design Review — wispace-bot (deep-module lens)

> Phân tích toàn monorepo qua lăng kính **deep module** (skill `codebase-design`): *module / interface /
> implementation / depth / seam / adapter / leverage / locality*. Thực hiện bởi 7 agent review song song
> theo cụm package/app, mỗi claim đều dẫn nguồn file+dòng trong source. Refresh theo HEAD
> `49ea385e` ngày 2026-08-26.

Phạm vi: 3 apps (`messenger-bot`, `discord-bot`, `zalo-bot`) + 19 packages, 763 file TS
(221 spec file, khoảng 88.5k dòng).
Baseline quy chiếu: `.claude/rules/clean-architecture.md`, `.claude/rules/project-conventions.md`,
`docs/project-overview.md`.

---

## 0. Refresh theo HEAD

Các thay đổi sau bản review ban đầu đã làm seam hiện tại rõ hơn nhưng chưa xoá các nợ thiết kế chính:

| Trạng thái | Quan sát hiện tại |
|---|---|
| **Đã cải thiện** | `CanonicalPlatformService` được dùng trong report cron của Messenger/Discord/Zalo; policy gửi đa nền tảng đã nằm sau một resolver dùng chung. |
| **Đã cải thiện một phần** | `WebhookInboundIngressPort` nay ở `packages/database/src/domain/ports`, và Zalo bind port này; Messenger vẫn dùng `WebhookInboundEventsPort` riêng nên vẫn còn hai interface cho cùng write-ahead inbox. |
| **Đã harden nhưng chưa deepen** | Discord/Zalo reconcile đã có advisory lock, stale-record drop và retry/telemetry; lifecycle vẫn là hai implementation gần clone, với behavior Discord (relink/welcome) không xuất hiện đầy đủ ở Zalo. |
| **Còn nguyên** | ~~`PrivacyDataService` vẫn resolve entity bằng tên chuỗi~~ (đã xử lý #461, 2026-09-02 — xem §3.1); `PlatformStudentReportService` vẫn tự map capacity và throw `Error` thường (`packages/student-report/src/platform-student-report.service.ts:101-161`); Messenger vẫn reserve quota trước rồi `ChatPipeline` reserve lại (`apps/messenger-bot/src/modules/messenger/application/services/messenger-chat-processor.service.ts:299-339`, `packages/chat-pipeline/src/chat-pipeline.ts:68-83`). |
| **Còn nguyên** | `OpsHealthRepositoryPort` yêu cầu `getLlmSafetyWarningsCount(since)` nhưng adapter bỏ qua `since` và hardcode 24 giờ (`packages/ops-health/src/types.ts:20`, `packages/ops-health/src/typeorm-ops-health.repository.ts:55-63`); package `ops-health` không có consumer runtime, Messenger giữ implementation riêng. |

Kết luận refresh: chưa có lý do để tạo thêm package/port tổng quát. Ưu tiên sửa các seam đang nói dối hoặc
đang bị bỏ qua; chỉ extract khi có adapter thứ hai thật và test đi qua interface mới.

---

## 1. Kết luận tổng

**Bản năng kiến trúc của repo đang đúng**: thuật toán nằm trong packages framework-agnostic, app chỉ là
adapter shell. Bằng chứng mạnh nhất là các **seam đa nền tảng thật** (≥2 adapters): chat pipeline,
study reminder (`MessageSenderPort` ×3), quota/metering (`BurstCounterPort` ×3), Wispace client header
(`x-psid|x-discordid|x-zaloid`), scheduler-core claim orchestration.

Nợ thiết kế không nằm ở "thiếu abstraction" mà ở 4 chỗ:

1. **Seam đã xây nhưng một platform chưa chuyển** — Messenger vẫn chạy bản copy riêng của report
   orchestration (279 dòng), calendar command (291 dòng).
2. **Clone Discord ↔ Zalo ở lifecycle chưa được extract** — account-link (~92% giống nhau ở reconcile
   cron), copy-drift đã **mất behavior thật** trên Zalo (relink-notification, welcome dedupe).
3. **Các khớp nối ("joints") giữa core đã extract** — quyền reserve quota nằm ở 2 tầng,
   memory-vs-redis branch nằm trong service body thay vì sau seam, env parsing lặp 3×.
4. **Test vượt qua interface đúng tại những chỗ đó** — QueryBuilder mock, assert SQL substring, fake
   "nói dối" che đúng nơi có defect thật.

---

## 2. Module map — điểm sáng và điểm yếu

### 2.1 Deep modules mẫu mực (giữ nguyên, học từ chúng)

| Module | Interface nhỏ | Implementation giấu bên trong |
|---|---|---|
| `llm-execution` (messenger app) | **1 method `run(fn, ctx)`** | p-limit concurrency + opossum breaker + retry/backoff + deadline AbortSignal + Redis global slot + metrics. *"Best module in the app"* |
| `LlmAgentService` (@wispace/llm-agent) | `reply`/`replyStream` | 910 LOC: rounds loop, dedupe/cap, injection redaction, grounding, context trimming, retry/timeouts |
| `LlmExecutionPort` + `createEnvLlmExecutionPort` | `run(fn, meta)` | Redis Lua lease slots, deadline composition, retry |
| `StudyReminderDispatchService` / `SyncService` | mỗi cái **1 method** | claim/crash-recovery/ambiguous/backoff; keyset paging, bounded concurrency, fail-closed provider check |
| `TypeormStudyReminderJobRepository` | 1 token DI | lease-claim/ambiguity/reopen state machine 565 LOC |
| `createStudyReminderProviders` | 1 factory call | toàn bộ sync/dispatch/worker wiring → module Discord/Zalo chỉ ~40 dòng |
| `RescheduleConfirmationService` | 4 methods | TTL, claim-lease, revert-on-failure |
| `ChatPipeline.flush` | 1 method + ports/hooks | compensation logic reserve→refund→markDelivered→history→markCompleted |
| `DebounceChatQueue`, `RedisChatQueueStore` | 4–5 methods | debounce/promotion/eviction/drain; locks/ZSET/crash replay 653 LOC |
| `ChatRateLimitCore` (+`BurstCounterPort` ×3 adapters) | 5 methods | burst+daily reserve, rollback, idempotency-retry recovery |
| `StudentReportCore` | 2 methods | fetch+retry, LLM call, parse JSON, fallback, error→message mapping |
| `report-formatter` (#124 design) | 5 fns | contract model thu còn 1 chuỗi `headline`; facts derive all-thuần |
| `bot-metrics` | `timeStep/timeLlmCall…` | metric definition + OTel span/exception (OTel inject qua config, không import) |
| `getTypeOrmOptions` (@wispace/database) | 1 call | TLS fail-closed policy + pool tuning + migration glob — xoá đi là policy tái xuất ×3 apps |
| `PlatformWebhookInboundEventService` / `PlatformDeadLetterService` | 9/6 methods | idempotent ingest, lease claim, backoff, bounded retention |
| `learner-profile` pure fns | 2 fns + hooks | grounding/TTL logic đáng lẽ tái xuất ×3 apps |

### 2.2 Shallow / rác cần dọn

| Module | Vấn đề |
|---|---|
| `ops-health` service+repo | Mồ côi: 0 external consumer; Messenger chạy bản riêng 270 dòng và chỉ import types. **Fail deletion test.** |
| `MessengerAgentService` (messenger) | Lớp đổi-tên 41 dòng; bị dịch ngược ngay tại `messenger-chat-pipeline-adapters.ts`; **14 specs / 21 mocks bảo vệ nó** |
| `createChatPipelineAdapters` outbound half | Hardcode `{delivered:true}` → `SendResult.partial` chết với Discord/Zalo |
| `redis-chat-queue.store.ts` wrapper (messenger) | Re-export 16 dòng nhưng spec 23 test/63 mock, trùng spec của package |
| Retry helpers ×4 | app-local discord ≈ zalo inline ⊂ llm-agent superset ⊂ wispace-client `withRetry` |
| `CleanupCronService.execute(config, deleteFn, isEnabled, getRetentionDays)` | Body chỉ đọc `name`+`advisoryLockId`; 5 field config chết trong khi cùng fact đến lại 3 lần qua callbacks |
| Privacy pair trong llm-agent | Sole consumer = messenger + import NestJS (vi phạm rule); SHALLOW + misplaced |
| `todayReportDate`, 6 alias date-fns trong date-utils | Re-export 1 dòng, fail deletion test |
| Barrel doors quá rộng | llm-agent index export ~47 values + 25 types (core chỉ cần ~6); bot-common ~37 symbols ép Nest+ioredis lên mọi consumer |

### 2.3 Seam giả định (1 adapter — indirection, không phải seam)

- `WebhookInboundIngressPort`: hiện có **Zalo consumer/bind**, nhưng Messenger vẫn khai
  `WebhookInboundEventsPort` riêng rồi bind inline lambda — cùng behavior nhưng hai interface.
- Multi-provider LLM: union `'anthropic'|'gemini'|'local'` nhưng factory fallback hết về OpenAI-compatible;
  openrouter/minimax chỉ là biến thể base-URL. Một adapter family tồn tại, phần còn lại là speculative.
- `ChatQueueStorePort`: chỉ Redis impl; memory mode **bypass port** bằng nhánh `distributed` trong service body.
- `UsageWriterPort`: 1 adapter; queued-writer chỉ tồn tại trong comment.
- `LearnerProfileStorePort` (1 class, 3 bindings), `CronLeaderLeasePort` (structural only),
  `WispaceClientLogger` (bị chính package bypass) — chỉ biện minh được như test substitution.

---

## 3. Defect thật tìm ra nhờ design lens (không phải bug-hunt)

1. **`PrivacyDataService` văng lỗi lúc runtime khi unlink/delete/export đa nền tảng**: resolve 11 entity
   qua tên chuỗi (`dataSource.getRepository(name)`), ngầm đòi DataSource đăng ký entity của cả 3 platform —
   không app nào làm vậy. Unit fake trả repo cho *mọi* tên nên test không thấy. Sửa bằng inject explicit
   `{ mappings: Record<Platform, EntityTarget>; scoped: EntityTarget[] }` + startup check.
   > **Đã xử lý (#461, 2026-09-02).** Registry inject qua constructor, `ENTITY_NAMES` + `as never` đã xoá,
   > startup fail-fast nêu tên entity thiếu. Mỗi app export `buildPrivacyEntityRegistry()`;
   > `database:privacy-smoke` gọi đúng builder đó trên Postgres thật cho cả 3 platform, seed platform khác
   > bằng external id **riêng biệt** và assert audit row của nhánh fan-out.
2. **Capacity-mapping drift gây sai UX thật**: bản copy trong `PlatformStudentReportService` throw
   `Error('No score data available')` thay vì `StudentReportNoScoreDataError` → catch-site `instanceof`
   hụt → user Discord/Zalo hết điểm nhận exception path thay vì thông báo hướng dẫn. Nguyên nhân gốc:
   mapping bị duplicate 2 nơi (một timezone-aware, một UTC) vì seam chưa được kéo về package.
3. **`getLlmSafetyWarningsCount(since)` vi phạm port của chính nó**: implement parameterless, hardcode 24h
   → knob `OPS_ALERT_FAILED_JOBS_HOURS` thành dead code (ops-health path không ai dùng).
4. **Double-reserve quota (latent)**: processor pre-reserve + pipeline tự reserve khi có `idempotencyKey`;
   reserve thứ 2 hit `idempotency_conflict` → `'in_flight'` → `allowed:false` → `flush` false **trước cả
   agent/send**. Mock stateless trong spec khiến không test nào thấy. Cần một interface term cho
   "already reserved" — tức đưa quyền quota về 1 phía.
5. **Copy-drift Discord→Zalo mất behavior**: Zalo thiếu relink-notification + welcome-dedupe trong reconcile
   cron; `readPositiveInt` lệch nhau; leader-lock chỉ Discord có; cross-platform dedup chỉ Zalo có.
6. **Vi phạm framework boundary tự tuyên bố**: NestJS trong `llm-agent/utils/privacy-state.service.ts`;
   `PlatformStudentReportService` kéo Nest+metering+database+wispace-client; `wispace-client` import
   `@nestjs/*`; gián tiếp `llm-agent` kéo Nest+ioredis qua bot-common barrel.
7. **Cùng port, khác semantics** (interface nói dối): history resolver Messenger fail-soft vs Platform
   fail-closed-at-boot; `appendToolSummary` memory = pending-until-next-turn vs Redis = persist-until-TTL;
   merge text xảy ra 3 lần dọc flow.
8. **Layering**: Zalo report cron nằm ở `infrastructure/persistence/` (vi phạm bảng layer của repo);
   reschedule recovery cron thiếu advisory lock mà mọi cron khác đều có; `exam-window.utils` import types
   từ một *service*.

---

## 4. Testability — quy luật quan sát được

> Nơi có port + stateful fake → spec đọc như behavior spec. Nơi inject class thô → spec thoái hóa thành
> "constructor archaeology".

**Tốt (chuẩn mực)**: fake `ChatQuotaRepositoryPort` mô phỏng stateful idempotency/reserve/refund → 17 test
assert outcome quan sát được; `agent.service.spec.ts` test xuyên `reply()/replyStream()` với stubbed
adapter; architecture tests (`zalo-module-boundaries.spec.ts`, `runtime-dependencies.spec.ts`) giữ lại.

**Xấu (testing past the interface)**:
- Fluent QueryBuilder mocks assert *call shape*, không assert outcome; assert SQL substring
  (`typeorm-reschedule-store.spec.ts`); fake tự cài lại ngữ nghĩa `ON CONFLICT`.
- Fake "nói dối" che defect: privacy fake trả repo cho mọi tên entity.
- Processor spec 633 dòng phải build 8 stub `as unknown as <Class>` cho constructor 13 deps.
- 14 test trên lớp pass-through 41 dòng (`MessengerAgentService`).
- Spec tự mock chính core (`platform-student-report.service.spec.ts` mock `StudentReportCore`) → bản
  mapping bị drift có **zero coverage**.
- Test duy nhất exercise nhánh transaction `upsertPendingJob` mà production **gọi 0 lần** → xoá port method,
  xoá test.

**Nguyên tắc áp dụng khi deepen**: *replace, don't layer* — spec cũ trên module shallow thành rác khi có
spec ở interface mới; test assert observable outcomes qua seam, sống sót qua internal refactor.

---

## 5. Kiểm kê seam

### Real seams (≥2 adapters) — tài sản của repo
`MessageSenderPort` ×3 platforms · `MappingReaderPort` ×2 · `CalendarPort`/`ReschedulePort` ×3 ·
`RescheduleStorePort` (memory + TypeORM) · `ReportClaimRepositoryPort` ×2+fake · `BurstCounterPort` ×3 ·
`ChatHistoryStorePort` (memory+Redis) · `RateLimiterPort` ×2 · `PlatformToolExecutorPort` ×2 ·
`LlmProviderAdapter` (OpenAI + Failover + scripted eval) · `LlmExecutionPort` (env factory ×2 packages +
app service) · `ToolExecutorPort<T>` ×2+scripted · `RedisClientPort` + fakes · `WispaceIdHeader` ×3 ·
`ChatPipeline` 4 ports (adapters riêng mỗi app).

### Missing seams (duplicated logic, xếp theo fix-amplification)

| # | Cụm | Bằng chứng | Interface ngầm |
|---|---|---|---|
| M1 | Account-link lifecycle | completion service 61/106 dòng chung; reconcile cron **126/137 (~92%)**; intent store + OAuth state store + mapping entity gần clone | `packages/account-link-core` |
| M2 | Report claim-and-send + daily batch | Messenger copy 279 dòng song song `ReportOrchestrationService`; Discord/Zalo cron near-twin ~200 LOC mỗi bên | outcome-typed `ReportDeliveryPort` + `runDailyReportBatch` |
| M3 | Quota ownership | pre-reserve ở processor + auto-reserve ở pipeline | `ChatPipeline` single owner + `onQuotaDenied` hook |
| M4 | Composition roots | `zalo-chat.module.ts` 488 ln ≈ `discord-chat.module.ts` ~440 ln (~70% wiring giống) | `createPlatformChatProviders` |
| M5 | Resilience Wispace calls | timeout→retry→breaker→error-map copy ×3; 5 endpoint trần trụi không retry/breaker | `runWispaceCall` nội bộ wispace-client |
| M6 | bot-common grab-bag | 37-symbol barrel ép Nest+ioredis lên 13+ consumer agnostic | tách `@wispace/log-hygiene` (6 file Nest-free sẵn có) |
| M7 | Calendar command | Messenger tự tiến hoá 291 dòng trong khi `PlatformStudyCalendarCommandService` đã có, signature khớp | adopt qua `USER_CALENDAR_DATA_PORT` |
| M8 | Env dialects | `CHAT_QUEUE_STORE` parse 3×, `CHAT_DEBOUNCE_MS` clamp copy, stuck-ms default dup, `readPositiveInt`/`readEnvBoolean` copies | `ChatRuntimeConfig` |
| M9 | Ops controllers | Discord↔Zalo 57/89 dòng chung | shared factory (ưu tiên thấp) |
| M10 | Durable-inbox port | Zalo đã bind `WebhookInboundIngressPort`; Messenger vẫn giữ bản port local tương đương | `WebhookInboundInboxPort` mở rộng port sẵn có |

---

## 6. Roadmap deepen (xếp theo leverage)

### Tier 0 — Sửa bug + dọn rác (rủi ro thấp, làm ngay)

1. **Sửa capacity-mapping drift**: kéo mapper vào `student-report` qua
   `createGoalsCapacityDataAdapter(goals: ReportGoalsPort): CapacityDataPort` (port đã khai báo sẵn),
   throw đúng `StudentReportNoScoreDataError`. Fix luôn bug UX #3.2. Consumers: messenger
   `TaskScoreAverageApiService` + platform service. Spec cũ của 2 bản copy gộp thành 1 mapper suite.
2. ~~**Sửa `PrivacyDataService`**: inject entity registry tường minh; xoá `ENTITY_NAMES` + `as never` casts.~~
   **Xong (#461, 2026-09-02)** — xem ghi chú ở §3.1.
3. **Fix-or-delete `ops-health`**: hoặc xoá svc/repo (giữ types Messenger dùng), hoặc cho Messenger delegate;
   implement `since` trung thực.
4. **Xoá double translation quanh agent**: adapters factory capture thẳng `PlatformAgentService`;
   tiêu diệt 14 specs/21 mocks của rename layer.
5. **Dead code sweep**: `readEnv*` copies (student-report bản chết), `acquireRedisSlot` export,
   `upsertPendingJob`+`lockKey` khỏi port, dangling comment `with-retry.ts:112-116`,
   `retry.utils.ts` của discord-bot (thay bằng bản superset của llm-agent).
6. **Relocate `PrivacyStateService`/`detectPrivacyIntent` về messenger** (fix framework-leak, deletion test pass).
7. **Thêm advisory lock cho reschedule recovery cron** (consistency với 4 cron còn lại).

### Tier 1 — Deepen lõi (leverage cao nhất)

1. **`packages/account-link-core`** (M1). Owner: package mới, dep `typeorm` thôi (như chat-metering).
   ```ts
   class LinkCompletionCore<P> { complete(input: LinkCompletionInput): Promise<LinkOutcome> }
   class LinkReconcileCronCore { runBatch(cfg): Promise<ReconcileBatchResult> }
   interface LinkFlowAdapter<P> {
     exchangeCode(code): Promise<{ id }>;
     upsertLink(userId, extId): Promise<{ relinked; previousUserId? }>;
     findUserIdByExtId(extId); onLinked?(user); onRelinked?(extId, prev);
   } // VerifyIntentStore + OauthStateStore đã tồn tại verbatim hôm nay
   ```
   Đây là lập luận second-adapter có thật: `DiscordLinkFlowAdapter` (guild/welcome) +
   `ZaloLinkFlowAdapter` (PKCE/text). 2 completion specs + 2 reconcile specs (~460 LOC) gộp thành
   package tests + 2 adapter specs nhỏ. Khôi phục behavior Zalo đã mất.
2. **Thống nhất report sending** (M2). Giữ `claimAndSend(...)`; đổi `ReportDeliveryPort.sendReport` trả
   `'sent' | 'ambiguous' | 'not_sent'` (mirror delivery-key #294 của reminders) để partial-send trở thành
   outcome thay vì special-case catch-block. Messenger bỏ orchestrator copy; thêm
   `runDailyReportBatch({ loadPage, sendUser, reportDate, concurrency? })` vào scheduler-core cho
   Discord/Zalo (và Messenger sau). Waste: `report-send-orchestration.service.spec.ts` + phần lớn
   discord orchestration spec → 1 port-level suite.
3. **`ChatPipeline` single quota owner** (M3). Thêm `onQuotaDenied?(ctx & {reason; limit})`, return
   `'delivered'|'denied'|'failed'`. Messenger xoá block pre-reserve (:297–347), deny copy chuyển vào hook.
   Waste: processor specs asserting reserve-wiring với stateless mock → 1 stateful fake limiter trong
   `chat-pipeline.spec.ts`. Giải từa latent double-reserve.
4. **Resilience pipeline trong wispace-client** (M5, chỉ cho thao tác retry-safe):
   ```ts
   runWispaceCall<T>(cfg, logger, op, externalId,
     send: (signal: AbortSignal) => Promise<Response>,
     parse: (raw: unknown) => T,
     o?: { maxBytes?; useBreaker? }): Promise<T>
   ```
   Hides timeout merge, backoff/jitter, breaker budget, `WispaceApiError` mapping, bounded read, masked
   logs cho endpoint đọc. Không áp dụng mù cho create/delete hoặc precreate vì các contract này yêu cầu
   no automatic retry để tránh side effect kép. Specs retry ×3 gộp thành 1 suite.
5. **Tách `@wispace/log-hygiene` từ bot-common** (M6): `error-message`, `mask-external-id`,
   `read-response-text`, `read-bounded-json`, `abort.utils`, `network-utils` (đã Nest-free);
   `withRetry`/`CircuitBreaker` về đây khỏi wispace-client. ≥13 named consumers; framework-agnostic
   packages thôi kéo `@nestjs/*`+`ioredis`.

### Tier 2 — Hoàn tất các seam dang dở (structural)

1. **Một chat stack**: Messenger route qua `PlatformChatQueueService` (thêm `onBeforeFlush?(batch)`),
   trước đó cho `OutboundServicePort.sendText` trả `{delivered; partial?}` thật cho Discord/Zalo.
   Che ~600 LOC machinery song song; xoá nhánh `distributed` nếu thêm `MemoryChatQueueStore` bọc
   `DebounceChatQueue` (hoặc chủ động xoá port — quyết định 1 trong 2, đừng giữ half-seam).
2. **`createPlatformChatProviders({platform, promptFile, outbound, …})`** trong chat-agent (M4) — mirror
   cái `createStudyReminderProviders` đã chứng minh (module 40 dòng).
3. **Privacy-consent conversation module**: `PrivacyConversationService.handle(externalId, text, opts?): Promise<boolean>`
   thoát khỏi private method của processor 13-deps; zalo/discord gateway là second/third adopter tự nhiên.
4. **Display-name platform-neutral**: inject neutral mapping reader (pattern đã có ở study-reminder) →
   move module vào package dùng chung; zalo-bot reuse được.
5. **`WebhookInboundInboxPort`** thống nhất durable-inbox (M10) — mở rộng port sẵn có, bind mỗi app 1 lần,
   PGLite/in-memory adapter thay QB-mock suites.
6. **`ChatRuntimeConfig`** (M8) — 1 parser cho ~25 keys, xoá clamp/default duplicated.
7. **Shrink `CleanupCronService.execute(name, advisoryLockId, deleteFn)`** + `withLockedTick(...)` wrapper
   cho 5 cron trong database package (fix unlocked recovery cron by construction).
8. **Keep Vault delivery single-path**: production receives only the validated AppRole bootstrap;
   runtime secret sync adapters and developer CLI helpers are retired.
9. **Adopt `PlatformStudyCalendarCommandService` trong Messenger** (M7) — signature khớp sẵn.

---

## 7. Chống-khuyến nghị (đừng làm)

- **Đừng thêm Anthropic/Gemini/local adapter** hay helper `generateValidatedJson` — mỗi cái <2 real
  consumers hôm nay. Union multi-provider hiện tại là speculative; xoá bớt còn hơn thêm.
- **Đừng bọc entities hay `MessageType`** vào port mới — entities là đúng kiểu interface-nông cần có;
  vocabulary message-type thuộc bot-common, không phải sau port.
- **Đừng thêm port mới khi chỉ nêu được 1 consumer** (rule: one adapter = hypothetical seam) — trừ khi
  consumer thứ hai là test fake mang hợp đồng trạng thái thật.
- **Đừng sửa defect bằng cách thêm nhánh** — 8 case ở §3 đều là triệu chứng của seam sai chỗ; sửa seam.

---

## 8. Phụ lục — verdict nhanh từng vùng

| Vùng | Verdict |
|---|---|
| `packages/study-reminder-shared`, `reschedule-confirm`, `learner-profile` | Exemplary deep — proof seam 3-platform hoạt động |
| `packages/scheduler-core` | DEEP core (`ReportOrchestrationService`); debt = platform chưa migrate + utils nông |
| `packages/chat-*` | Cores pass deletion test; shallowness nằm ở *joints* (quota ownership, mode branching, env dialects) |
| `packages/llm-agent` | DEEP cores (`LlmAgentService`, provider, execution slice); wide front door + misplaced privacy pair |
| `packages/student-report` | Core DEEP; `PlatformStudentReportService` SHALLOW/duplicating + vi phạm boundary |
| `packages/database` | Đa số DEEP services; leaky `PrivacyDataService` (latent defect), triplicated inbox port, cron skeleton ×4 |
| `packages/wispace-client` | Endpoint clients deep; internals shallow (resilience ×3, 5 endpoints naked) |
| `packages/bot-common` | Grab-bag MIXED — deep units chôn trong barrel; cần split |
| `packages/bot-metrics`, `date-utils` | DEEP/MIXED — metrics remain useful; date-utils still has a few aliases |
| `packages/ops-health` | SHALLOW + orphaned — fix-or-delete |
| `apps/discord-bot` / `zalo-bot` | Adapter shells tốt trên shared seams; debt = account-link clones + composition roots |
| `apps/messenger-bot` | Package-backed tốt; debt = constructor-width processor, rename layer, 2 mảnh logic WISPACE-domain còn mặc đồ Messenger |
