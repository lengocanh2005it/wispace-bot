# LLM/resilience coverage audit — 2026-09-11

**Phạm vi.** Audit chỉ đọc tại HEAD hiện tại: source, tests, `AGENTS.md`,
`docs/llm-fallback-policy.md`, `docs/project-overview.md`, và các issue GitHub
đang mở/đã đóng liên quan (`gh issue list/view`). Không sửa code và không tạo
hay cập nhật issue. Worktree đã có thay đổi của người dùng; các file đó không
được dùng làm bằng chứng.

## Covered areas

Các nhóm dưới đây đã có code hoặc issue owner; không nên mở thêm issue trùng
chỉ vì tên nhóm nghe giống nhau:

| Nhóm | Bằng chứng hiện tại | Issue/ghi chú |
|---|---|---|
| LLM retry, failover, error taxonomy, retry amplification | `packages/llm-agent/src/execution/env-llm-execution.port.ts#L220-L258`, `packages/llm-agent/src/utils/retry.utils.ts#L31-L89` | #870, #750, #496, #498, #500; còn việc phải làm nhưng đã có owner. |
| Admission, deadline, abort, overload/load-shed | `packages/llm-agent/src/execution/env-llm-execution.port.ts#L154-L169`; shared admission trong `packages/llm-agent` | #389 (đã đóng), #951, #831, #1033/#1034. |
| WISPACE timeout/retry/circuit và cache stampede | `packages/wispace-client/src/utils/with-retry.ts#L64-L123`, `packages/wispace-client/src/cache/wispace-data-cache.ts#L71-L216` | #457/#466/#533, #568 (stampede), #767. Cache identity/invalidation: #705/#877. |
| Redis history, queue, degradation, HA, shutdown/fairness | Lua append trong `packages/chat-history/src/redis-chat-history-store.ts#L40-L70`; queue retry/lease trong `packages/chat-agent/src/chat-queue` | #516, #532, #555, #594, #614, #667, #817, #409, #269. |
| Delivery ambiguity, fallback, durable jobs/dead-letter | `packages/chat-pipeline/src/chat-pipeline.ts` và platform outbound adapters | #662, #758, #799, #789, #899, #979; không replay mù khi delivery ambiguous. |
| Safety, prompt/history replay, eval và telemetry | `packages/llm-agent/src/agent.service.ts#L935-L950`, safety/eval packages | #1029/#1030, #1040–#1043, #997, #685, #780/#789. |

## Candidate blind spots

Đây là các điểm có bằng chứng cụ thể nhưng chưa cần issue mới; nên gắn vào
issue hiện hữu hoặc chốt thành acceptance/test. Mức độ là độ tin cậy của nhận
định, không phải severity.

### 1. WISPACE `429` và `Retry-After` đang có contract mâu thuẫn (cao)

- Contract fixture `packages/wispace-client/contracts/error-scenarios.json#L6-L11`
  yêu cầu `429` được retry sau header `Retry-After: 5`.
- Runtime `WispaceApiError.isRetryable()` chỉ trả `true` cho `5xx`
  (`packages/wispace-client/src/errors/wispace-api.error.ts#L1-L14`), còn
  `isWispaceRetryable()` ghi rõ “Never retry 4xx” và không đọc header
  (`packages/wispace-client/src/utils/with-retry.ts#L64-L78`). Không thấy
  đường truyền `Retry-After` vào retry scheduler.

Như vậy fixture có thể xanh nhưng không mô tả hành vi runtime. Cần quyết định
`429` nào là quota/deterministic (fallback ngay) và `429` nào là transient;
nếu transient thì parse delta-seconds/date, cap theo request budget, rồi mới
jitter khi không có hint. Gắn acceptance vào #457/#466 (WISPACE resilience) và
#887 (contract drift/test evidence); chưa nên mở issue trùng.

### 2. Durable chat-queue retry dùng một delay cố định (cao)

`CHAT_FLUSH_RETRY_DELAY_MS` chỉ đọc một lần (`packages/chat-agent/src/chat-queue/chat-queue-retry.config.ts#L23-L43`),
và mỗi lần failed batch đều truyền đúng giá trị đó
(`packages/chat-agent/src/chat-queue/platform-chat-queue.service.ts#L611-L639`).
Không có attempt-aware exponential backoff hay jitter. Khi nhiều pod cùng gặp
outage, các lease có thể được thả cùng lúc và tạo burst mới dù provider/Redis
đang hồi phục.

Issue #577 (retry-jitter inventory) đã đóng nhưng inventory/acceptance không
bao gồm path này; #532 và #555 đang mở ở vùng Redis queue/parity nhưng chưa có
acceptance cho backoff/jitter của durable chat retry. Nên mở rộng #555 hoặc
re-open/đính chính #577, không tạo issue “retry jitter” thứ ba. Test cần kiểm tra
attempt/cap/deadline/lease và RNG deterministic.

### 3. Redis history payload được cast, chưa validate shape (trung bình-thấp)

`RedisChatHistoryStore.getHistory()` chỉ kiểm tra JSON là array rồi cast thẳng
thành `ChatHistoryMessage[]` (`packages/chat-history/src/redis-chat-history-store.ts#L91-L99`).
Lua append cũng coi JSON hỏng là mảng rỗng và ghi đè (`#L46-L70`). Trong khi đó
`buildSafeHistory()` luôn truyền `entry.content` vào sanitizer
(`packages/llm-agent/src/agent.service.ts#L935-L950`). Payload cũ/hỏng với role,
content hoặc tool fields sai kiểu có thể làm hỏng cả turn thay vì bỏ qua entry.

Đây chưa phải lỗi đã tái hiện; nên thêm fixture corruption/shape validation vào
#667 (history read degradation) hoặc #303 (PG/Redis integration/restart), với
metric/quarantine bounded và fallback về history rỗng. Không mở issue mới trước
khi có bằng chứng payload hỏng thực tế.

### 4. Kill-switch LLM bypass toàn bộ deadline/admission (trung bình, trade-off cần chốt)

Khi `LLM_EXECUTION_ENABLED=false`, execution port gọi `fn(undefined)` ngay
(`packages/llm-agent/src/execution/env-llm-execution.port.ts#L154-L161`), nên
không còn deadline, retry budget hay admission guard của port. Đây có thể là
ý đồ cho emergency disable, nhưng nếu caller/provider client có timeout/retry
riêng thì vẫn có nguy cơ request treo hoặc retry ngầm trong lúc incident.

Chốt contract trong #951 (fail-closed env validation) cùng #831 (incident
controls) và #870 (SDK retry config): “disabled” phải fail-fast typed, hoặc vẫn
giữ request deadline; thêm metric/log để biết bypass đang hoạt động. Không mở
issue riêng.

### 5. Streaming posture đang xung đột (cao về quyết định, không phải production bug)

Hiện không có bot production dùng `replyStream`; #440 yêu cầu định nghĩa
mid-stream failover trước khi dùng, #751 yêu cầu xoá hẳn streaming path vì đây
là code path an toàn thứ hai, còn #894 lại yêu cầu wire stream vào chat để có
status/progressive reply. Ba issue này mô tả ba hướng không tương thích. Để
stream path tồn tại mà chưa có ADR/owner sẽ làm mọi thay đổi guardrail/fallback
phải duy trì hai semantics.

Đây là quyết định roadmap: chọn xoá (#751) hoặc giữ và làm contract failover
(#440), rồi mới cân nhắc UX (#894). Không mở issue reliability mới.

### 6. Cache invalidation/write-through là best-effort và không có metric lỗi (thấp,
trade-off đã biết)

`invalidateUser()` xoá local rồi fire-and-forget shared deletion
(`packages/wispace-client/src/cache/wispace-data-cache.ts#L100-L112`);
write-through cũng fire-and-forget (`#L151-L154`) và catch rỗng
(`#L278-L302`). Điều này có thể tạo một cửa sổ stale sau mutation/cross-pod,
nhưng #705 đã ghi rõ accept-stale bounded deletion là out of scope và TTL là
backstop; #877 sở hữu privacy/identity. Chỉ cần thêm metric/alert nếu vận hành
cần quan sát, không mở issue mới và không biến cache stale thành fallback dữ liệu
cho calendar/scores nếu product chưa chấp thuận.

## Existing-ticket mapping

| Quan sát | Nơi nên cập nhật | Không nên làm |
|---|---|---|
| WISPACE `429`/`Retry-After` | #457 → #466; contract evidence ở #887 | Không mở issue WISPACE retry thứ tư. |
| Chat durable retry fixed delay | #555 hoặc điều chỉnh scope #577; phối hợp #532 | Không coi #577 “jitter mọi path” đã hoàn tất khi queue path chưa có acceptance. |
| Redis history shape/corruption | #667 hoặc #303; nếu chỉ là schema drift thì #857 | Không thêm parser framework trước khi có failing fixture. |
| LLM kill-switch semantics | #951, #831, #870 | Không thêm retry layer ở caller. |
| Streaming contract/roadmap | #440, #751, #894 (một ADR/quyết định) | Không wire production streaming trước khi chọn posture. |
| Cache invalidation observability | #705, #877, #780 | Không đổi sang stale-if-error mặc định cho dữ liệu học tập. |

## Confidence and recommendation

Độ tin cậy cao rằng backlog hiện tại đã có owner cho các mảng lớn (LLM
failover/retry, admission, WISPACE breaker, Redis HA/queue, delivery
idempotency, safety/eval). Ba điểm cần đưa lên khi triage gần nhất là:

1. làm rõ contract `429/Retry-After` của WISPACE;
2. bổ sung durable chat retry vào inventory/acceptance jitter (fixed delay hiện
   là gap thực);
3. chốt ADR streaming trước khi có caller production.

History shape, kill-switch semantics và cache error metrics là follow-up/test
hoặc policy, chưa đủ bằng chứng để tạo issue mới. Kết luận audit: **không tạo
issue mới trong lượt này; cập nhật các issue mapping ở trên là đủ để track.**
