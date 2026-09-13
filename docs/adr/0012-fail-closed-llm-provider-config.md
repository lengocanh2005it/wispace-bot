# Fail-closed LLM provider configuration

**Status: accepted**

Every active LLM provider in the resolved primary/failover order must resolve an effective endpoint and an explicit model at startup. The shared provider factory enforces the WISPACE URL policy plus a required exact-host `LLM_ALLOWED_BASE_URLS` policy and exact provider/model `LLM_ALLOWED_MODELS` policy; any invalid candidate fails the whole chain instead of being pruned or silently defaulted. The same policy is rechecked for request model overrides, while feature-specific routing remains owned by #417.

We keep vendor-default base URLs only after they pass validation, preserve the development/test loopback exception, retain Messenger's generic variables as compatibility aliases (conflicts fail), and do not add DNS pinning or feature routing to this slice. An enabled input classifier cannot use an ambiguous failover model until a feature policy exists; it fails startup rather than silently selecting a provider. `LLM_EXECUTION_ENABLED=false` keeps the existing fallback behavior through the normal unconfigured-adapter wiring, but the execution wrapper is a passthrough that bypasses admission, deadlines, retries, and circuit protection, and the provider policy validation is skipped. It is not a hard-stop or load-shed control; hard-stop semantics are tracked separately in [#951](https://github.com/lengocanh2005it/wispace-bot/issues/951).

## Considered options

- **Drop an invalid failover candidate:** rejected because a deployment would appear healthy while silently losing redundancy.
- **Use full URL/path allowlists:** rejected for now; the shared WISPACE policy is exact-host based and endpoint pinning can be a separate hardening change.
