---
status: accepted
---

# Joint scan for split-message prompt injection

Debounce merges several learner messages into one chat turn while history is sanitized entry by entry, so a prompt-injection payload split across those boundaries can evade the single-turn regex guard. Keep the existing guard and add a shared, bounded joint-scan at the LLM agent boundary over optional ordered `userTextParts` plus sanitized recent user history; reserve the 4,000-character budget for current content, render selected history before the current turn in chronological order, exclude assistant/tool-summary entries, and preserve the model-facing merge format. A joint hit blocks before the provider with the existing reply/event path (`reason=multi_turn`), while per-entry history sanitation remains responsible for `source=history` telemetry. This keeps behavior consistent across platforms without duplicating gateway scans, accepting the deliberate blind spot outside the bounded recent view.
