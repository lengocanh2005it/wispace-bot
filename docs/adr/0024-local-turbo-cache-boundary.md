# Local developer Turbo remote-cache boundary

**Status: accepted (#1243)**

## Context

The repository already uses Turborepo caching in trusted CI. Pull requests and
forks are intentionally credentialless, while trusted push and scheduled or
manually dispatched verification have the credentials needed for the existing
CI cache behavior. Dependency installation and unrelated jobs do not receive
Turbo credentials.

Developers also need fast verification after a clean checkout or branch change.
Without a documented local policy, a developer could either miss useful remote
artifacts or copy a CI write credential into a local environment. The latter
would widen the cache write boundary and allow a compromised checkout to poison
artifacts later consumed by trusted CI.

## Decision

Local verification is local-only by default and must succeed without remote
credentials. Developers may opt in to remote reuse only in Turbo's native
local-read/write plus remote-read-only mode, using a dedicated least-privilege
credential or a separately approved namespace. A separate namespace still does
not permit local uploads: the local invocation remains remote read-only. The
local process never writes to the CI remote cache.

If the provider cannot supply the required read-only boundary, local-only
verification remains the supported workflow. A CI write token is never an
acceptable substitute.

The user-level login mechanism is storage convenience, not an authorization
boundary. The stored developer credential must itself be read-only, and every
local invocation that reads remote artifacts must request remote-read-only mode.
An invocation-scoped secret store is preferred when available; `npm ci` and
non-Turbo jobs never receive the credential.

Remote cache is an optimization, not a correctness dependency: a miss or
remote outage falls back to local execution. Turbo's content hash, rather than
branch name, determines artifact reuse. Turbo's native dry-run JSON is used to
distinguish cache result and cache source; no custom parser or wrapper is added.

The existing CI event and credential boundary remains unchanged. Pull requests
and forks stay credentialless; trusted push and scheduled or manually
dispatched verification retain their current behavior and secret scoping.

Remote-cache signing and artifact provenance are deliberately deferred. Trusted
CI remains the writer boundary, and the residual integrity risk is documented
for a future decision if the trust model or provider capabilities change.

## Alternatives considered

- **Reuse the CI write credential locally:** rejected because a local checkout
  would gain the ability to upload or poison artifacts in the CI namespace, and
  the token could leak through local process or shell handling.
- **Give local developers a shared read/write namespace:** rejected because it
  still permits cross-developer poisoning and makes revocation broad.
- **Local-only forever:** rejected because it gives up safe remote reuse across
  clean checkouts when an approved read-only boundary is available.
- **Add a custom cache wrapper or parser:** rejected because Turbo already
  exposes cache mode and hit-source diagnostics at the verification seam.
- **Enable remote-only local verification:** rejected because remote cache must
  remain an optimization and local fallback is required.

## Consequences

Developers have a credentialless default and an explicit fast path for approved
remote reads. Clean checkouts and branches can reuse artifacts when hashes match,
while input changes still invalidate the affected work.

The repository documents that the repository maintainer or CI operator obtains
and revokes a provider-side read-only credential or namespace; the secret value
never enters the repository. Remote outages can reduce performance but do not
block verification. The absence of remote-cache signing remains a known,
bounded residual risk rather than an unrecorded assumption.
