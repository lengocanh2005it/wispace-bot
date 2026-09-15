# LLM cost measurement — 2026-09-15 (offline, #972)

## Mục đích

Điền ô còn trống duy nhất trên bản đồ audit #693: *"LLM cost is measured well enough for #588 and #589 to set real thresholds"*. Trước đo này, #588 (per-user ceiling), #589 (unit economics), #665 (prompt caching) và #554 (trim descriptions) đều sizing trên con số chưa ai đo.

## Phương pháp và giới hạn

- Đo offline từ artifact đã build (`packages/llm-agent/dist`) + file prompt thật; không gọi provider, không DB.
- **Hai thước token:** `real` (xấp xỉ cl100k/o200k: ~4 ký tự/token ASCII, ~2.5/token tiếng Việt — con số dùng để báo giá) và `ceil` (heuristic `estimateTokens` của chính repo, 3.06× real — đây là trần budget mà admission control dùng, không phải chi phí thật).
- Giá: `gpt-5.4` $2.50/1M input, $15.00/1M output (AGENTS.md); cached input giả định $0.25/1M (10%) — **cần đối chiếu bảng giá provider trước khi dùng cho quyết định tiền**.
- Payload dữ liệu (goals/scores, calendar 5 entry) là đại diện hợp lý, không phải dữ liệu thật. Suffix display-name Messenger xấp xỉ 1 dòng. Một round = một provider call.
- Đo đạc chuẩn xác nhất là **aggregate từ `llm_usage_events`** (repo đã lưu usage mỗi call) — việc này cần DB prod, để lại làm bước kế tiếp; doc này trả lời "đơn vị kinh tế cỡ nào" bằng ước lượng có căn cứ.

## Chi phí cố định mỗi round (chat — gửi lại mọi round)

| Bot | System (real) | Tools (real) | **Tổng/round (real)** | Trần heuristic |
|---|---|---|---|---|
| Messenger | 1.803 | 1.609 | **3.412** | 10.451 |
| Discord | 1.693 | 1.609 | **3.302** | 10.114 |
| Zalo | 1.646 | 1.609 | **3.255** | 9.973 |

**Tools payload là 47,2% của prefix cố định** — lớn hơn cả system prompt.

## Chi phí theo lượt (realistic → trần heuristic), giá gpt-5.4

| Kịch bản | Input (real) | Output | **USD/lượt** | Trần |
|---|---|---|---|---|
| Chào hỏi, không tool (1 round) | 3.702 | 80 | **$0,0105** | $0,0281 |
| **Lượt điển hình: 1 tool, 2 rounds** | 7.622 | 300 | **$0,0236** | $0,0596 |
| History nặng, 2 rounds | 9.702 | 300 | **$0,0288** | $0,0648 |
| Kẹt cap: 6 rounds, 3 tool calls | 29.542 | 460 | **$0,0808** | $0,1908 |

Giả định: history 260 token real điển hình / 1.300 nặng; reply ~220 token; tool-call ~40 token; tool-result calendar ~537 token real.

## Report và reminder — output mới là thứ đội chi phí

| Feature | Input (real) | Output cap | USD | Trong đó output |
|---|---|---|---|---|
| Daily report (JSON) | 262 | 500 | **$0,0082** | $0,0075 (92%) |
| Study reminder (JSON) | 267 | 500 | **$0,0082** | $0,0075 (92%) |

Prompt chỉ ~140–210 token. Hạ `maxOutputTokens` cho reminder (shape cố định) là đòn bẩy thật; trim prompt report/reminder gần như vô nghĩa.

## Hệ quả cho các issue đang mở

1. **#588 / #589 có số để đặt ngưỡng:** lượt chat điển hình **$0,02–0,03**, trần hợp lý $0,06; lượt kẹt cap $0,08–0,19. 1.000 report/ngày ≈ $8,2/ngày ($0,0082 × 1.000).
2. **#665 (prompt caching): có đáng làm nhưng không phải đòn bẩy lớn nhất.** Prefix cache được = 3.412 token → tiết kiệm **$0,0077/round** (≈28–33% một lượt điển hình, $7,68/1k lượt, $768/100k lượt). Làm được, nhưng…
3. **#753 (gửi đúng tool theo intent) lớn hơn caching:** tools là 47,2% prefix. Lượt 1-intent chỉ cần 2–3 tool thay vì 8 → cắt ~55–70% prefix, và giảm cả JSON schema parse phía provider.
4. **#921 đo được chính xác:** suffix "Policy vocabulary" = **351 token real = 21,8% tool payload = 10,3% prefix cố định** — thu hoạch ròng, không đổi hành vi.
5. **#554 đúng hướng nhưng nhỏ hơn #921/#753.**
6. **Cảnh báo cho #972:** không dùng `estimateTokens` để kế toán chi phí — nó cao hơn thực tế 3,06× (an toàn cho budget cap, sai cho tiền). Dùng usage do provider trả về trong `llm_usage_events`.

## Bước kế tiếp

Aggregate `llm_usage_events` theo feature/platform/tháng để thay ước lượng bằng số thật (cần truy cập DB prod hoặc staging có traffic). Sau đó #588/#589 đặt ngưỡng trên phân phối thực, không phải scenario.

## Related

- #972 (owner), #588, #589, #665, #554, #921, #753, #962
- #693 — bản đồ audit; ô "LLM cost" được tick bằng doc này (ước lượng offline; số thật từ `llm_usage_events` là refinement)
- Script đo: one-off, không lưu trong repo — phương pháp ở mục "Phương pháp và giới hạn" đủ để tái tạo (cần `packages/llm-agent/dist` đã build).
