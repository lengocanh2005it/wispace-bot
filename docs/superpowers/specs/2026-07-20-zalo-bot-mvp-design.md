# Zalo Bot MVP — Design Spec

Ngày: 2026-07-20
Phase: Turborepo migration plan — Phase 4 (`apps/zalo-bot`)
Tham chiếu: `docs/turborepo-migration-plan.md`, `apps/discord-bot` (Phase 3, dùng làm khuôn mẫu adapter-vào-package-dùng-chung).

## 1. Mục tiêu & phạm vi MVP

Triển khai `apps/zalo-bot` (NestJS app mới trong monorepo) với scope MVP:

- Webhook nhận tin nhắn từ Zalo Official Account (OA), verify signature, trả lời qua LLM agent dùng chung (`@wispace/llm-agent`).
- Account-linking: Zalo Login OAuth (PKCE) ↔ WISPACE `userId`, tái dùng `WISPACE_API_VERIFY_TOKEN_URL` như Messenger/Discord.
- OA access token lifecycle: tự động refresh token (access_token 1h, refresh_token 30 ngày, dùng 1 lần).

**Ngoài phạm vi MVP này** (ghi nợ kỹ thuật, làm ở phase sau khi có nhu cầu thật):

- Quota/rate-limit (`packages/chat-metering`) — chưa áp dụng cho Zalo ở MVP.
- Tool WISPACE thật (goals/calendar/reschedule) — MVP chỉ stub `available: false` như Discord giai đoạn đầu.
- ZNS (Zalo Notification Service) cho tin ngoài cửa sổ 48h / báo cáo định kỳ — tương đương `register_exam_report_notifications`, cần ngân sách + duyệt template, để phase sau.
- Debounce/merge tin nhắn liên tiếp (`packages/chat-queue-core`) — xử lý từng tin ngay, không gom.
- Chat history bền vững/multi-pod — dùng `@wispace/chat-history` in-memory (giống Discord), không Redis.

## 2. Kiến trúc tổng thể

`apps/zalo-bot` là NestJS HTTP app (`NestFactory.create`, không phải `createApplicationContext`, vì cần expose cả webhook lẫn OAuth callback qua HTTP). 4 module, theo đúng 4 tầng Clean Architecture (`domain/application/infrastructure/presentation`) như quy ước chung của repo:

```
apps/zalo-bot/src/modules/
├── zalo-webhook/    # nhận + verify + dispatch webhook event
├── zalo-chat/        # adapter LLM agent + outbound message
├── zalo-oauth/       # token OA lifecycle + account-linking Zalo Login
└── wispace/          # stub tool handlers (ToolExecutorPort)
```

Không import chéo `MessengerModule`/`DiscordModule` từ app khác — mọi thứ dùng chung đi qua `packages/*` (`@wispace/llm-agent`, `@wispace/chat-history`, `@wispace/wispace-client` cho phần header `x-zaloid` đã có sẵn).

## 3. `modules/zalo-webhook/`

**Trách nhiệm:** nhận HTTP POST từ Zalo, verify tính toàn vẹn, dispatch theo loại sự kiện.

- `presentation/controllers/zalo-webhook.controller.ts`: `POST /zalo/webhook`.
  - Verify header `X-ZEvent-Signature` = `sha256(appId + rawBody + timestamp + oaSecretKey)` trước khi parse JSON. Sai signature → HTTP 401, log cảnh báo, không xử lý tiếp.
  - Đọc `event_name` để dispatch:
    - `user_send_text` (và các `user_send_*` khác nếu cần sau) → gọi `ZaloChatService.handleIncomingMessage(senderId, text)`.
    - `follow` → gửi tin chào mừng + gợi ý link tài khoản WISPACE (kèm link `GET /zalo/oauth/authorize`) qua `ZaloOutboundService`.
    - `unfollow` → chỉ log, không hành động thêm.
    - `oa_send_*` (echo do chính OA gửi, kể cả từ OA Admin) → bỏ qua hoàn toàn, tránh vòng lặp xử lý tin của chính mình.
  - Luôn trả HTTP 200 nhanh sau khi nhận (theo đúng semantics webhook của Zalo — không có response body đặc biệt).
- `domain/entities/zalo-webhook-event.entity.ts`: type thuần cho payload đã parse (`sender.id`, `user_id_by_app`, `event_name`, `message.text`, `timestamp`...). Không gắn decorator ORM.

**Không xử lý ở MVP:** `user_send_image`/`user_send_sticker`/... — log và trả lời mặc định "chỉ hỗ trợ tin nhắn văn bản" nếu nhận được loại khác `user_send_text`.

## 4. `modules/zalo-chat/`

**Trách nhiệm:** orchestration chat qua LLM, gửi tin trả lời.

- `application/agent/zalo-agent.service.ts`: adapter mỏng quanh `LlmAgentService` (`@wispace/llm-agent`), theo đúng pattern `MessengerAgentService`/`DiscordAgentService`:
  - Build system prompt từ `apps/zalo-bot/src/shared/prompts/zalo-chat.system.txt` (load qua `loadSystemPromptFile()`).
  - Implement các port: `LlmExecutionPort`, `LlmUsageRecorderPort` (ghi nhận nhưng **không** gắn với quota — chỉ log usage để theo dõi, không enforce limit ở MVP), `LlmSafetyEventPort`, `AgentMetricsPort`, `ToolExecutorPort` (trỏ tới `modules/wispace/` stub).
  - Retry lỗi tạm thời từ OpenAI/provider giống các app khác (`isOpenAiRetryableError`).
- `application/services/zalo-chat-history.service.ts`: dùng `MemoryChatHistoryStore` từ `@wispace/chat-history` trực tiếp (không NestJS wrapper phức tạp, giống `DiscordChatHistoryService`), đọc TTL/maxMessages qua env riêng của app (`ZALO_CHAT_HISTORY_TTL_MS`, `ZALO_CHAT_HISTORY_MAX_MESSAGES`).
- **Xử lý từng tin ngay khi webhook nhận được** — không debounce/merge (khác Messenger's `packages/chat-queue-core`).
- `infrastructure/zalo-outbound.service.ts` (`ZaloOutboundService`): implement `MessageSenderPort`-tương-đương, gọi `POST https://openapi.zalo.me/v3.0/oa/message/cs` (header `access_token` lấy qua `ZaloTokenService.getValidAccessToken()`).

**Xử lý user chưa link tài khoản:** LLM agent vẫn trả lời chat tự do (không gọi được tool WISPACE vì stub trả `available: false`); tool stub tự chèn thông báo gợi ý link tài khoản kèm link OAuth khi phát hiện câu hỏi cần dữ liệu WISPACE — đúng pattern Discord.

## 5. `modules/zalo-oauth/`

Tách 2 luồng con độc lập trong cùng module, vì cùng dùng chung `secret_key`/`app_id` của Zalo app.

### 5.1 Token OA lifecycle (server-to-server, không liên quan user cụ thể)

- **Entity mới** `zalo_oa_tokens` (migration trong `apps/messenger-bot/src/infrastructure/database/` theo quy ước DB dùng chung, hoặc trong `apps/zalo-bot` nếu app đã có migration riêng — quyết định cụ thể khi viết implementation plan): `id`, `access_token`, `refresh_token`, `access_token_expires_at`, `refresh_token_expires_at`, `updated_at`. Chỉ 1 row (đơn OA), không cần khóa theo `oa_id` ở MVP vì chỉ có 1 OA.
- `ZaloTokenService`:
  - `getValidAccessToken(): Promise<string>` — đọc row, trả `access_token` nếu còn hạn.
  - Cron (`@Cron`, mỗi 45 phút, `ZaloTokenRefreshService`): nếu `access_token_expires_at` còn dưới buffer 10 phút → gọi `POST https://oauth.zaloapp.com/v4/access_token` (header `secret_key`, body `grant_type=refresh_token` + `refresh_token` hiện tại + `app_id`) → ghi đè **cả** `access_token` và `refresh_token` mới (refresh_token chỉ dùng được 1 lần — bắt buộc lưu cặp mới mỗi lần refresh, nếu quên sẽ mất khả năng refresh tiếp).
  - Nếu refresh thất bại (refresh_token hết hạn quá 30 ngày, ví dụ downtime dài) → log lỗi nghiêm trọng (không có tự phục hồi, cần cấp lại token thủ công qua bootstrap).
- **Bootstrap ban đầu:** lấy `access_token`/`refresh_token` lần đầu là thao tác thủ công 1 lần (chạy OAuth code flow qua Zalo OA admin, hoặc script CLI ad-hoc), ghi vào bảng qua migration data hoặc ops script — **không** tự động hoá vì chỉ chạy đúng 1 lần lúc setup. Ghi rõ trong runbook (`apps/zalo-bot/docs/`).

### 5.2 Account-linking Zalo Login OAuth (PKCE, theo user cụ thể)

- **Entity mới** `zalo_oauth_states`: `state` (PK, string random), `code_verifier`, `created_at`. TTL 10 phút — kiểm tra bằng điều kiện `created_at < now() - interval '10 minutes'` khi query lấy state ở callback (row hết hạn coi như không tồn tại, có thể dọn định kỳ bằng cron riêng hoặc để tồn tại vô hại — quyết định cụ thể ở implementation plan).
- **Entity mới** `zalo_account_links` (tương đương `discord_account_links`): `zalo_user_id`, `wispace_user_id`, `linked_at`.
- `presentation/controllers/zalo-oauth.controller.ts`:
  - `GET /zalo/oauth/authorize`: sinh `code_verifier` (random string) + `code_challenge` = `base64url(sha256(code_verifier))` (không padding), lưu `{state, code_verifier}` vào `zalo_oauth_states`, redirect user sang Zalo Login authorize URL kèm `code_challenge` + `state`.
  - `GET /zalo/oauth/callback`: nhận `code` + `state` → tra `zalo_oauth_states` lấy `code_verifier` (báo lỗi nếu không tìm thấy/hết hạn) → `POST https://oauth.zaloapp.com/v4/access_token` (`grant_type=authorization_code`, `code`, `code_verifier`, header `secret_key`) lấy user access_token → `GET https://graph.zalo.me/v2.0/me?fields=id,name` lấy Zalo user `id` → gọi `WISPACE_API_VERIFY_TOKEN_URL` (header `X-Internal-Key`, body `{token: state (hoặc token WISPACE tự sinh, theo đúng contract 3 bot hiện có), value: zaloUserId, platform: 'zalo'}`) lấy `userId` → upsert `zalo_account_links` → xoá `zalo_oauth_states` row đã dùng → gửi tin chào mừng qua `ZaloOutboundService`.

**Lưu ý khác Discord:** Zalo Login bắt buộc PKCE (Discord OAuth2 không cần) — đây là lý do cần bảng `zalo_oauth_states` riêng thay vì tái dùng thẳng pattern Discord's OAuth controller.

## 6. `modules/wispace/`

Stub `ZaloAgentToolsService` implement `ToolExecutorPort` từ `@wispace/llm-agent` — mọi tool trong `AGENT_TOOLS` trả `{ available: false, message: '<thông báo tiếng Việt gợi ý link tài khoản kèm link OAuth>' }` khi `ctx.userId` chưa resolve (chưa link), giống hệt `DiscordAgentToolsService` giai đoạn đầu (trước khi có `modules/wispace/` thật). Khi `ctx.userId` đã có (đã link qua `zalo_account_links`) — **vẫn stub** ở MVP này (làm tool thật là phase sau), nhưng message trả về nên khác đi (ví dụ: "tính năng đang được phát triển" thay vì "chưa liên kết") để phân biệt 2 trạng thái.

## 7. Data flow tóm tắt

```
User gửi tin → Zalo → POST /zalo/webhook (verify signature)
  → event_name=user_send_text → ZaloChatService
    → ZaloAccountLinkService.findUserIdByZaloId(senderId) (có thể null)
    → LlmAgentService.reply() (ToolExecutorPort = stub, trả available:false nếu chưa link)
    → ZaloOutboundService.send() (dùng ZaloTokenService.getValidAccessToken())

User bấm link "Liên kết tài khoản" → GET /zalo/oauth/authorize
  → redirect Zalo Login → GET /zalo/oauth/callback
  → verify PKCE, đổi code, lấy zaloUserId, gọi WISPACE verify-token
  → upsert zalo_account_links → gửi DM chào mừng

Cron (mỗi 45 phút) → ZaloTokenRefreshService
  → check zalo_oa_tokens.access_token_expires_at
  → nếu sắp hết hạn: refresh, ghi đè access_token + refresh_token mới
```

## 8. Testing

- Unit test cho: `ZaloWebhookController` (verify signature đúng/sai, dispatch đúng theo `event_name`, bỏ qua `oa_send_*`), `ZaloTokenService`/`ZaloTokenRefreshService` (refresh thành công, refresh thất bại khi refresh_token hết hạn), `ZaloOauthController` (PKCE flow đúng/sai state, verify-token gọi đúng payload), `ZaloAgentToolsService` (2 trạng thái message stub), `ZaloChatService` (gọi LLM agent, dùng chat history đúng TTL).
- Không có test end-to-end thật ở giai đoạn spec này (cần Zalo OA thật + webhook URL public HTTPS + `WISPACE_API_VERIFY_TOKEN_URL` phản hồi thật) — ghi nợ giống Discord Phase 3.

## 9. Migration / DB

3 bảng mới (tên cụ thể, migration viết theo `/typeorm-migration` skill khi implement):
- `zalo_oa_tokens`
- `zalo_oauth_states`
- `zalo_account_links`

Không đổi bảng nào đã có (DB dùng chung, khóa `(platform, external_user_id)` đã generalize từ Phase 2 — Zalo chỉ cần `platform='zalo'` khi có nhu cầu dùng `packages/chat-metering`/`packages/wispace-client` ở phase sau).

## 10. Env mới cần thêm

`ZALO_APP_ID`, `ZALO_APP_SECRET_KEY`, `ZALO_OA_SECRET_KEY` (dùng verify webhook signature, khác `APP_SECRET_KEY` dùng cho OAuth token), `ZALO_CHAT_HISTORY_TTL_MS`, `ZALO_CHAT_HISTORY_MAX_MESSAGES`, `WISPACE_API_VERIFY_TOKEN_URL` (đã có, dùng chung 3 bot).

## 11. Cải thiện tương lai (ngoài phạm vi MVP này, sắp theo thứ tự ưu tiên đề xuất)

Danh sách này mở rộng mục 1 ("ngoài phạm vi MVP") thành lộ trình cụ thể hơn — mỗi mục nên là 1 spec/plan riêng khi thực sự bắt tay làm, không gộp vào MVP hiện tại để tránh phình scope.

1. **Tool WISPACE thật** (`modules/wispace/` từ stub → thật) — `get_user_goals`, `get_learning_progress_report`, `get_upcoming_study_sessions`, `list_study_calendar_entries`, `preview_next_study_reminder` gọi `@wispace/wispace-client` với `idHeader='x-zaloid'` (đã hỗ trợ sẵn từ Phase 3). Làm ngay sau khi MVP account-linking đã chạy ổn định — đây là giá trị lớn nhất mang lại cho user, nên ưu tiên cao nhất trong danh sách này.
2. **`reschedule_study_session`** — tương đương Discord button confirm/cancel; Zalo OA hỗ trợ nút bấm trong tin nhắn dạng list/template, cần khảo sát API "gửi tin kèm nút" của Zalo (chưa tra trong spec này) trước khi thiết kế chi tiết.
3. **Quota/rate-limit** (`packages/chat-metering`, `platform='zalo'`) — áp dụng khi lưu lượng chat thật tăng, tái dùng `ChatRateLimitCore`/`LlmUsageRecorderCore`/`LlmSafetyCore` như Discord, cấu hình `MemoryBurstCounter` + `DirectUsageWriter` (bản rút gọn, không BullMQ) làm điểm khởi đầu.
4. **ZNS (Zalo Notification Service)** — thay thế `register_exam_report_notifications`: tạo + xin duyệt template trước, cân nhắc ngân sách (tính phí theo `price_sdt`/`price_uid` mỗi tin) trước khi cam kết tính năng báo cáo định kỳ ngoài cửa sổ 48h. Phụ thuộc quyết định ngân sách phía WISPACE, không chỉ là việc kỹ thuật.
5. **Cron báo cáo định kỳ trước ngày thi** (port `ReportCronService` sang Zalo) — chỉ có ý nghĩa sau khi có ZNS (mục 4), nếu không sẽ là tính năng nửa vời giống lý do Discord chưa làm `register_exam_report_notifications`.
6. **Debounce/merge tin nhắn** (`packages/chat-queue-core`) — nếu người dùng thực tế hay gửi nhiều tin liên tiếp (rời rạc từng câu) gây trải nghiệm reply rời rạc, thêm `DebounceChatQueue` như Messenger.
7. **Chat history bền vững / multi-pod** — nếu cần scale nhiều instance `apps/zalo-bot`, thay `MemoryChatHistoryStore` bằng backend Redis (đã có sẵn `ChatHistoryStoreResolver` pattern bên Messenger để tham khảo).
8. **Dọn dẹp `zalo_oauth_states` hết hạn** — hiện MVP chỉ lọc bằng điều kiện thời gian khi query; nếu bảng phình to theo thời gian (nhiều lượt authorize bỏ dở), thêm cron xoá row quá TTL, tương tự stuck-reserved recovery bên `packages/chat-metering`.
9. **Multi-OA support** — MVP giả định chỉ 1 Official Account (bảng `zalo_oa_tokens` không khóa theo `oa_id`). Nếu WISPACE cần vận hành nhiều OA (ví dụ theo trung tâm/chi nhánh), phải thêm `oa_id` làm khóa và refactor `ZaloTokenService` từ single-row sang lookup theo OA.
10. **Whitelist / audit table cho quota event** — nếu áp dụng mục 3, cân nhắc thêm các phần Messenger-only hiện có (whitelist UX, `chat_quota_events` audit) nếu Zalo cần độ quan sát tương đương — không bắt buộc, chỉ làm khi có nhu cầu vận hành thực tế.
