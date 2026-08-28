# Rà soát issue mở: performance, latency, resilience và distributed systems

**Snapshot:** 2026-08-28 (Asia/Ho_Chi_Minh)
**Repository:** [`lengocanh2005it/wispace-bot`](https://github.com/lengocanh2005it/wispace-bot)
**HEAD đã rà:** `c003b65df22987ddb76a1869daa6d4cc4fdf30f5`
**Phương pháp:** `gh issue list --state open` + đọc body/comment của các issue liên quan và kiểm tra source tại HEAD. Có **199 issue đang mở** (105 `ready-for-agent`, 7 `needs-triage`); snapshot này không coi issue mở là bằng chứng code còn thiếu nếu comment đã nói “implemented”. Quy ước tracker: [`docs/agents/issue-tracker.md`](../agents/issue-tracker.md).

## Kết luận ngắn

Backlog đã bao phủ phần lớn các pattern quan trọng: bounded admission, retry budget, circuit breaker, backpressure/load-shed, fairness, jitter, HA PostgreSQL/Redis, single-VPS SPOF, lease fencing, chaos drill, và end-to-end load benchmark. Không nên mở thêm issue trùng các nhóm đó.

Hai lỗ hổng có bằng chứng code rõ nhất nên xử lý thêm:

1. **Re-open #406 cho Messenger**: bản sửa đã đóng issue chỉ đi qua `PlatformChatQueueService`; Messenger vẫn xoá batch Redis trong `finally` nếu cả pipeline và fallback đều fail.
2. **Issue mới P1: drain distributed Redis queue khi SIGTERM**: worker distributed chỉ dừng timer, không chờ poll/flush đang chạy; `onModuleDestroy` của queue service chỉ drain memory queue.

Một issue policy P2 đáng cân nhắc (hoặc làm subtask của #269/#422): quyết định rõ guarantee của durable inbox khi stale processing — hiện tại là at-most-once ở boundary đó và có thể mất event đã ACK.

## Những nhóm issue mở đã bao phủ

| Nhóm | Issue mở tiêu biểu | Đánh giá / thứ tự |
|---|---|---|
| Đo latency, saturation, capacity | [#374](https://github.com/lengocanh2005it/wispace-bot/issues/374), [#529](https://github.com/lengocanh2005it/wispace-bot/issues/529), [#587](https://github.com/lengocanh2005it/wispace-bot/issues/587), [#569](https://github.com/lengocanh2005it/wispace-bot/issues/569), [#570](https://github.com/lengocanh2005it/wispace-bot/issues/570) | #374 là owner của benchmark p50/p95/p99 và resource telemetry. Làm sau khi các fix hot-path và admission hoàn tất; không mở thêm issue “load test” khác. |
| LLM admission/retry/failover | [#453](https://github.com/lengocanh2005it/wispace-bot/issues/453), [#513](https://github.com/lengocanh2005it/wispace-bot/issues/513), [#514](https://github.com/lengocanh2005it/wispace-bot/issues/514), [#457](https://github.com/lengocanh2005it/wispace-bot/issues/457) → [#466](https://github.com/lengocanh2005it/wispace-bot/issues/466), [#581](https://github.com/lengocanh2005it/wispace-bot/issues/581), [#580](https://github.com/lengocanh2005it/wispace-bot/issues/580), [#584](https://github.com/lengocanh2005it/wispace-bot/issues/584) | Có đủ bounded wait, retry amplification, breaker half-open, fairness và metastable recovery. Ưu tiên contract #457 rồi implementation #466; #513/#514 là P1. |
| Redis queue/cache hot path | [#454](https://github.com/lengocanh2005it/wispace-bot/issues/454), [#452](https://github.com/lengocanh2005it/wispace-bot/issues/452), [#451](https://github.com/lengocanh2005it/wispace-bot/issues/451), [#532](https://github.com/lengocanh2005it/wispace-bot/issues/532), [#578](https://github.com/lengocanh2005it/wispace-bot/issues/578), [#579](https://github.com/lengocanh2005it/wispace-bot/issues/579), [#583](https://github.com/lengocanh2005it/wispace-bot/issues/583), [#586](https://github.com/lengocanh2005it/wispace-bot/issues/586) | Đã có issue cho overlapping poll, RTT amplification, stampede, cold-start, smoothing và load shed. **Shutdown drain** chưa có issue implementation; xem đề xuất bên dưới. |
| WISPACE/per-request resilience | [#457](https://github.com/lengocanh2005it/wispace-bot/issues/457), [#466](https://github.com/lengocanh2005it/wispace-bot/issues/466), [#533](https://github.com/lengocanh2005it/wispace-bot/issues/533) | Đã nhận diện nested retry, AbortSignal bị drop, endpoint không có breaker/timeout. Không mở thêm executor issue. |
| HA / disaster recovery | [#408](https://github.com/lengocanh2005it/wispace-bot/issues/408), [#409](https://github.com/lengocanh2005it/wispace-bot/issues/409), [#410](https://github.com/lengocanh2005it/wispace-bot/issues/410), [#273](https://github.com/lengocanh2005it/wispace-bot/issues/273), [#515](https://github.com/lengocanh2005it/wispace-bot/issues/515), [#593](https://github.com/lengocanh2005it/wispace-bot/issues/593) | Đủ DB HA, Redis HA, fleet SPOF, offsite backup, external watchdog và full-fleet DR. RTO/RPO drill cần chạy sau khi #273/#408/#409 có artifact thật. |
| Chaos/integration evidence | [#269](https://github.com/lengocanh2005it/wispace-bot/issues/269), [#303](https://github.com/lengocanh2005it/wispace-bot/issues/303) | #303 = CI repeatable PG/Redis restart; #269 = staging multi-failure drill. Giữ hai scope riêng. |
| Cron/lease/coordination | [#449](https://github.com/lengocanh2005it/wispace-bot/issues/449), [#459](https://github.com/lengocanh2005it/wispace-bot/issues/459), [#464](https://github.com/lengocanh2005it/wispace-bot/issues/464), [#481](https://github.com/lengocanh2005it/wispace-bot/issues/481), [#510](https://github.com/lengocanh2005it/wispace-bot/issues/510), [#521](https://github.com/lengocanh2005it/wispace-bot/issues/521), [#528](https://github.com/lengocanh2005it/wispace-bot/issues/528), [#531](https://github.com/lengocanh2005it/wispace-bot/issues/531), [#592](https://github.com/lengocanh2005it/wispace-bot/issues/592) | Đã bao phủ lock namespace, overlap, unlocked retry, cleanup race, blue-green double scheduler và shared job primitive. |
| Fan-out/cache/DB access | [#456](https://github.com/lengocanh2005it/wispace-bot/issues/456), [#458](https://github.com/lengocanh2005it/wispace-bot/issues/458), [#547](https://github.com/lengocanh2005it/wispace-bot/issues/547), [#568](https://github.com/lengocanh2005it/wispace-bot/issues/568), [#567](https://github.com/lengocanh2005it/wispace-bot/issues/567), [#525](https://github.com/lengocanh2005it/wispace-bot/issues/525), [#523](https://github.com/lengocanh2005it/wispace-bot/issues/523) | Đã có cache, dedupe-before-upstream, keep-alive, bounded transaction và regex size-cap. |
| Distributed architecture | [#576](https://github.com/lengocanh2005it/wispace-bot/issues/576), [#422](https://github.com/lengocanh2005it/wispace-bot/issues/422), [#467](https://github.com/lengocanh2005it/wispace-bot/issues/467), [#468](https://github.com/lengocanh2005it/wispace-bot/issues/468), [#469](https://github.com/lengocanh2005it/wispace-bot/issues/469), [#476](https://github.com/lengocanh2005it/wispace-bot/issues/476) | MVCC direction, fallback policy, shared account-link/report/inbox seams đã có owner. Chỉ thêm issue khi có invariant hoặc failure mode cụ thể. |

## Issue hygiene: đừng re-file issue đã đóng

Các issue sau hiện **CLOSED** theo GitHub, dù lịch sử comment vẫn hữu ích: [#372](https://github.com/lengocanh2005it/wispace-bot/issues/372) (metrics/OTel + usage), [#378](https://github.com/lengocanh2005it/wispace-bot/issues/378) (index/query plan), [#389](https://github.com/lengocanh2005it/wispace-bot/issues/389) (bounded LLM admission), [#396](https://github.com/lengocanh2005it/wispace-bot/issues/396), [#397](https://github.com/lengocanh2005it/wispace-bot/issues/397), [#407](https://github.com/lengocanh2005it/wispace-bot/issues/407), [#411](https://github.com/lengocanh2005it/wispace-bot/issues/411). Đặc biệt:

- #372 đã ghi nhận OTel SDK chỉ bootstrap ở Messenger và WISPACE timing từng chỉ OTel; commit đóng issue đã thêm Prometheus fallback. Không tạo issue OTel parity trùng #372 nếu chưa có regression mới.
- #479 còn **OPEN** nhưng comment nói typed error đã được wiring; còn thiếu test phân loại `is48hWindowError` và delivery spec, nên xử lý test rồi đóng thay vì mở issue mới.
- #406 đã **CLOSED**, nhưng audit comment sau đó ghi nhận regression chưa được cover ở Messenger; đây là lý do để **re-open chính #406**, không tạo issue trùng tên.

## Đề xuất 1 — re-open #406: Messenger Redis flush vẫn mất batch khi cả hai đường gửi fail

### Bằng chứng

- Messenger distributed flush claim batch tại [`messenger-chat-processor.service.ts#L188-L197`](https://github.com/lengocanh2005it/wispace-bot/blob/c003b65df22987ddb76a1869daa6d4cc4fdf30f5/apps/messenger-bot/src/modules/messenger/application/services/messenger-chat-processor.service.ts#L188-L197), rồi luôn gọi `completeChatBuffer()` trong `finally` tại [#L240-L265](https://github.com/lengocanh2005it/wispace-bot/blob/c003b65df22987ddb76a1869daa6d4cc4fdf30f5/apps/messenger-bot/src/modules/messenger/application/services/messenger-chat-processor.service.ts#L240-L265).
- `ChatPipeline` gọi `onError` rồi rethrow lỗi gốc tại [`chat-pipeline.ts#L186-L214`](https://github.com/lengocanh2005it/wispace-bot/blob/c003b65df22987ddb76a1869daa6d4cc4fdf30f5/packages/chat-pipeline/src/chat-pipeline.ts#L186-L214). Messenger `onError` bắt lỗi fallback và không ném tiếp tại [`messenger-chat-processor.service.ts#L102-L143`](https://github.com/lengocanh2005it/wispace-bot/blob/c003b65df22987ddb76a1869daa6d4cc4fdf30f5/apps/messenger-bot/src/modules/messenger/application/services/messenger-chat-processor.service.ts#L102-L143).
- `scheduleRetryFlush()` chỉ được gọi trong shared `PlatformChatQueueService` ([`platform-chat-queue.service.ts#L418-L446`](https://github.com/lengocanh2005it/wispace-bot/blob/c003b65df22987ddb76a1869daa6d4cc4fdf30f5/packages/chat-agent/src/chat-queue/platform-chat-queue.service.ts#L418-L446)); `rg` không thấy Messenger processor gọi nó. Vì vậy main send fail + fallback fail → `finally` clear `processingTexts`.

### Scope nên thêm vào #406

- Messenger phải dùng cùng state transition retry/fencing như D/Z; không được `complete` khi batch đã được schedule retry.
- Regression thật trên Messenger Redis path: pipeline fail + fallback fail → batch còn trong Redis; retry thành công → complete đúng một lần.
- Test stale-worker takeover và shutdown trong lúc `processChatBatch` đang chạy.

## Đề xuất 2 — issue mới P1: drain distributed Redis chat queue khi SIGTERM

**Tiêu đề gợi ý:** `[Reliability][P1] Gracefully drain and fence distributed Redis chat queues on shutdown`

### Bằng chứng

- Worker khởi động timer và gọi poll fire-and-forget tại [`redis-chat-queue.worker.ts#L30-L36`](https://github.com/lengocanh2005it/wispace-bot/blob/c003b65df22987ddb76a1869daa6d4cc4fdf30f5/packages/chat-agent/src/chat-queue/redis-chat-queue.worker.ts#L30-L36).
- `onModuleDestroy()` chỉ `clearInterval`, trả về `void`, không lưu hoặc await poll/flush đang chạy tại [`redis-chat-queue.worker.ts#L38-L43`](https://github.com/lengocanh2005it/wispace-bot/blob/c003b65df22987ddb76a1869daa6d4cc4fdf30f5/packages/chat-agent/src/chat-queue/redis-chat-queue.worker.ts#L38-L43).
- `PlatformChatQueueService.onModuleDestroy()` chỉ drain `this.queue` — queue memory; distributed mode enqueue thẳng vào `queueStore` tại [`platform-chat-queue.service.ts#L262-L285`](https://github.com/lengocanh2005it/wispace-bot/blob/c003b65df22987ddb76a1869daa6d4cc4fdf30f5/packages/chat-agent/src/chat-queue/platform-chat-queue.service.ts#L262-L285).
- Messenger có cùng lệch này: `MessengerChatEnqueueService` luôn drain `debounceQueue` memory tại [`messenger-chat-enqueue.service.ts#L124-L126`](https://github.com/lengocanh2005it/wispace-bot/blob/c003b65df22987ddb76a1869daa6d4cc4fdf30f5/apps/messenger-bot/src/modules/messenger/application/services/messenger-chat-enqueue.service.ts#L124-L126), trong khi distributed flush nằm ở processor/Redis worker.

### Acceptance criteria gợi ý

- SIGTERM ngừng nhận work mới, dừng timer, và await mọi poll/flush đang in-flight trong ngân sách shutdown 45s.
- Buffer Redis chưa claim vẫn tồn tại; buffer đang processing phải được complete/requeue bằng owner/fencing token, không xoá mù.
- Enqueue đến sau thời điểm drain bắt đầu bị reject theo contract hiện tại; không tạo batch mới rồi bị bỏ.
- Nếu timeout drain, ghi metric/log low-cardinality và để lease recovery của pod khác tiếp tục; không mark thành công giả.
- Test slow LLM + SIGTERM, pending buffer, pipeline/fallback failure và concurrent takeover; chạy trên cả Messenger và `PlatformChatQueueService` D/Z.

**Liên kết:** [#406](https://github.com/lengocanh2005it/wispace-bot/issues/406) (durability/fencing), [#269](https://github.com/lengocanh2005it/wispace-bot/issues/269) (chaos drill), [#511](https://github.com/lengocanh2005it/wispace-bot/issues/511) (OTel SIGTERM handler), [#454](https://github.com/lengocanh2005it/wispace-bot/issues/454) (re-entrancy).

## Đề xuất 3 — issue policy P2 (hoặc subtask của #269/#422): durable inbox delivery guarantee

**Tiêu đề gợi ý:** `[Reliability][P2] Define webhook inbox semantics for stale processing and idempotent side effects`

### Vì sao đây là gap distributed-systems, không phải thêm retry tuỳ ý

- Sau khi ACK, event nằm trong `webhook_inbound_events`; retry worker claim bằng lease token tại [`platform-webhook-inbound-event.service.ts#L147-L160`](https://github.com/lengocanh2005it/wispace-bot/blob/c003b65df22987ddb76a1869daa6d4cc4fdf30f5/packages/database/src/services/platform-webhook-inbound-event.service.ts#L147-L160).
- Nếu worker stale, code terminalize và **không replay tự động** tại [`platform-webhook-inbound-retry-cron.service.ts#L138-L160`](https://github.com/lengocanh2005it/wispace-bot/blob/c003b65df22987ddb76a1869daa6d4cc4fdf30f5/packages/database/src/services/platform-webhook-inbound-retry-cron.service.ts#L138-L160). Docs cũng ghi rõ lựa chọn này tại [`docs/project-overview.md#L298-L306`](https://github.com/lengocanh2005it/wispace-bot/blob/c003b65df22987ddb76a1869daa6d4cc4fdf30f5/docs/project-overview.md#L298-L306).
- Điều này tránh duplicate outbound side effect nếu crash xảy ra **sau** send nhưng **trước** mark-complete; ngược lại, crash **trước** side effect sẽ làm mất event đã được ACK. Đây là trade-off at-most-once/at-least-once cần được tuyên bố và test, không nên để implicit.

### Acceptance criteria gợi ý

- Ma trận per event type/platform: side effect nào idempotent theo `event_id`, guarantee nào (at-most-once hoặc at-least-once), và manual recovery ra sao.
- Nếu chọn at-least-once cho event type, thêm idempotency/outbox key ở handler trước khi replay; nếu chọn at-most-once, tạo metric/ops path cho `abandoned-stale` và tài liệu hoá mất event có chủ đích.
- Chaos test kill process trước/sau outbound send, retry cùng event nhiều lần; kiểm tra không duplicate ngoài policy và không silently lose event ngoài policy.
- Cập nhật [#269](https://github.com/lengocanh2005it/wispace-bot/issues/269) và [#422](https://github.com/lengocanh2005it/wispace-bot/issues/422), không tạo thêm queue infrastructure.

Nếu team chưa muốn chọn guarantee lúc này, chỉ thêm mục này vào #269/#422; đừng mở issue implementation mù.

## Đề xuất 4 — P3, nên mở rộng #532 thay vì issue mới: LLM usage writer không durable khi shutdown

`DirectUsageWriter` là fire-and-forget, retry tối đa một lần rồi drop tại [`direct-usage-writer.ts#L8-L49`](https://github.com/lengocanh2005it/wispace-bot/blob/c003b65df22987ddb76a1869daa6d4cc4fdf30f5/packages/chat-metering/src/llm-usage/direct-usage-writer.ts#L8-L49); `dispose()` còn huỷ retry chờ mà không await in-flight. D/Z adapter chỉ gọi `core.dispose()` khi destroy; Messenger writer custom cũng không có `OnModuleDestroy`/flush tại [`llm-usage-recorder.service.ts#L84-L112`](https://github.com/lengocanh2005it/wispace-bot/blob/c003b65df22987ddb76a1869daa6d4cc4fdf30f5/apps/messenger-bot/src/modules/llm-usage/application/services/llm-usage-recorder.service.ts#L84-L112). Comment của [#532](https://github.com/lengocanh2005it/wispace-bot/issues/532) đã ghi nhận đúng rủi ro này; nên mở rộng acceptance của #532 (bounded outbox/retry + flush shutdown + metric), không thêm BullMQ/Redis chỉ cho vài event hiện tại. [#549](https://github.com/lengocanh2005it/wispace-bot/issues/549) vẫn là issue riêng cho failed/aborted attempt metering.

## Thứ tự đề xuất

1. Re-open #406 (Messenger data-loss path) và tạo issue shutdown drain P1.
2. Làm P1 hiện có: #512, #513, #514, #466 (sau #457), #408/#409; sau đó chạy #303.
3. Chạy #374 benchmark với các scenario của #453/#454/#529/#532 và đo trước/sau.
4. Chốt delivery guarantee của inbox trong #269/#422; chỉ mở issue riêng nếu cần thay đổi code.
5. Sau khi có số liệu traffic thật, xử lý P2/P3 fan-out/cache/fairness/cost (#547/#568/#580/#583/#587–#590).
