---
status: accepted
---

# Provider failover health, quarantine, and cost attribution

## Context

The provider factory already fails closed for missing credentials, unsafe
endpoints, and unapproved models. The failover adapter, however, treats an
authentication failure like a timed outage: it opens a long cooldown and
tries the same credential again after the cooldown expires. A permanently
wrong primary can therefore remain invisible while a fallback serves every
request.

The adapter already returns the provider/model that produced a completion, and
usage rows preserve that metadata. Cost lookup is still ambiguous when the
same model name has different prices at different providers.

## Decision

- Validate credential shapes only for providers in the resolved failover
  order while execution is enabled. OpenAI credentials must begin with `sk-`
  but not `sk-or-`; OpenRouter credentials must begin with `sk-or-v1-`.
  MiniMax and `openai-compatible` credentials keep the non-empty check because
  their key formats are not a shared contract. The validation is enforced in
  every enabled environment, including tests; the existing disabled-execution
  passthrough remains exempt because it makes no provider call.
- Record one provider outcome for every actual provider call, with bounded
  `success`/`failure` labels. Missing usage metadata does not turn a returned
  completion into a failure. Caller aborts/deadlines, cooldown skips, and
  pre-call suppression are not provider outcomes.
- Track success count and long-cooldown streak per provider. The streak covers
  `quota_exceeded`, `auth`, and `rate_limit`, resets on success, and makes a
  never-served provider alertable after three consecutive long-cooldown
  outcomes. Any non-long-cooldown provider outcome also breaks that streak.
  Emit one error-level log and one alertable metric event per provider/process
  threshold crossing.
- After three consecutive normalized `auth` failures, quarantine that provider
  for the rest of the process lifetime. The auth streak resets after success or
  any non-auth failure. Quarantined providers are skipped without a call; if
  all candidates are quarantined, the adapter does not enter degraded mode or
  call them again; it emits the existing provider-exhausted/fallback path after
  recording the quarantine skips. A restart is the recovery mechanism. State is
  process-local; concurrent in-flight calls may finish after the threshold and
  do not require a per-provider lock.
- Attribute usage and cost to the actual provider/model returned by the
  completion. Provider+model pricing is preferred; model-only pricing remains
  only as a compatibility path when the process has a single provider. A
  fallback completion never uses the primary provider's price. The provider
  keys use `LLM_COST_USD_PER_1M_<DIRECTION>_TOKENS_<PROVIDER>_<MODEL>` with
  the same normalization used by the existing model-only keys.
- A never-served alert resets when the provider succeeds and may fire again on
  a later threshold crossing. The metric is an event counter; the alert rule
  resolves through its Prometheus increase window, with no separate resolve
  metric. Missing provider-specific pricing in a multi-provider process yields
  an unpriced event rather than silently using a legacy model-only price.
- Wire the shared metrics and alert rule through Messenger, Discord, and Zalo;
  cover boot validation, auth quarantine, never-served alerting, unchanged
  rate-limit cooldown behavior, and actual-provider usage/cost attribution in
  tests.

## Alternatives rejected

- Silently dropping a malformed candidate: it hides a deployment error and
  changes the redundancy contract.
- Retrying authentication failures on a timer: a bad credential is not a
  transient outage and repeatedly exposes it to the provider.
- Applying the primary model's price to fallback completions: it corrupts cost
  attribution and can hide the true provider spend.
- Guessing key prefixes for MiniMax or arbitrary OpenAI-compatible endpoints:
  those providers do not share a repository-wide credential-shape contract.

## Consequences

The process still recovers provider availability by restarting after a
quarantine. A provider can be temporarily long-cooled without being
quarantined, while a provider that has never served and repeatedly enters long
cooldown becomes visible even when a fallback keeps learner-facing traffic
healthy. Existing provider-exhausted behavior and critical alerting remain
unchanged.

Related: #1166, ADR-0006, ADR-0012.
