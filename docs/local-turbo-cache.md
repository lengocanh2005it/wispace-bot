# Local Turbo cache workflow

This repository uses Turborepo for the verification graph. Local verification
must work without remote-cache credentials. Remote reuse is an optional speed
optimization with a narrower trust boundary than CI.

## Policy at a glance

| Run | Credentials | Cache policy | Local writes to CI remote cache |
| --- | --- | --- | --- |
| Local default | None | Local filesystem cache | No |
| Local opt-in | Dedicated approved read-only credential | Local read/write, remote read-only | No |
| Pull request or fork | None | Existing local fallback | No |
| Trusted push | Existing CI Turbo credentials | Existing CI behavior | Unchanged |
| Scheduled/manual verification | Existing CI Turbo credentials | Existing forced verification behavior | Unchanged |
| `npm ci` and unrelated jobs | None | No Turbo remote-cache access | No |

The local policy does not change the CI workflow. Pull requests and forks stay
credentialless. Trusted CI keeps its existing remote-cache behavior. The
dependency-install step and unrelated build jobs never receive Turbo
credentials.

## Terms

- **Local cache**: artifacts stored in the developer workstation filesystem
  cache.
- **CI remote cache**: the remote Turbo artifact store used by trusted CI.
- **Cache mode**: the local and remote read/write permissions for one Turbo run.
- **Cache result**: `HIT` when an artifact is reused or `MISS` when work runs.
- **Cache source**: `LOCAL`, `REMOTE`, or no source when the result is a miss.

## Default local verification

Install dependencies first, without Turbo credentials:

```text
npm ci
npm run verify
```

This path uses the local filesystem cache and remains the supported path for
contributors without remote-cache access. Do not export CI credentials globally
just to run this command.

## Optional remote read-only verification

Remote reuse requires an approved developer credential that is read-only, or a
separate approved namespace with the same write isolation. A separate namespace
is acceptable only when the local invocation remains remote read-only; it is not
permission to upload from a developer checkout. The repository does not
provision that credential or namespace. Request access from the repository
maintainer or CI operator, who provisions and revokes it in the cache provider
outside this repository. If the provider cannot supply the required boundary,
stay on the default local-only path. Never reuse a CI write token.

After `npm ci`, log in through Turbo interactively so the token is stored in the
user profile rather than the repository:

```text
npx --no-install turbo login
```

If the provider requires manual token entry, use the interactive manual login
prompt. Do not pass a token on the command line, place it in a project `.env`,
or commit it to a script. An equivalent user-level secret store is acceptable
when it injects credentials only for the Turbo invocation. A user-level Turbo
login is not itself a permission boundary: the stored credential must be
read-only, and every local command that uses remote artifacts must still pass
the remote-read-only cache mode. `npm ci` and non-Turbo jobs do not receive the
credential.

Run the full repository verification with Turbo's native remote-read-only mode:

```text
npm run verify -- --cache="local:rw,remote:r"
```

The local process may read an approved remote artifact but never uploads its
results to the CI remote cache. A remote miss or unavailable remote endpoint
falls back to local execution; it must not turn verification into a network
dependency.

## Seeing hits, misses, and sources

Use Turbo's native dry-run JSON for cache diagnostics. Keep the same cache mode
and cache directory as the run being investigated. Replace
`<isolated-cache-dir>` with a new directory outside the checkout:

```text
npx --no-install turbo run typecheck test build --cache-dir="<isolated-cache-dir>" --dry=json --output-logs=hash-only
```

For an approved remote-read-only run, add
`--cache="local:rw,remote:r"` to the same command.

For a task, interpret the result as follows:

| Turbo result | Meaning |
| --- | --- |
| `status=HIT`, `source=LOCAL` | The local filesystem cache supplied the artifact. |
| `status=HIT`, `source=REMOTE` | The approved remote cache supplied the artifact. |
| `status=MISS` | No reusable artifact was available; the task must run. |
| Remote warning plus successful local execution | Remote access was unavailable; verification continued locally. |

Do not write a parser for this output. Turbo's JSON result and normal task
output are the source of truth.

## Clean-checkout validation

Use an isolated cache directory outside the checkout so the validation does not
depend on artifacts left by another run. The directory can be supplied through
Turbo's native cache-directory option. The following commands show the
credentialless baseline; use the same directory for every step:

1. Start with a new empty cache directory and no Turbo credentials.
2. Run a dry-run diagnosis. Relevant tasks should report `MISS`:

   ```text
   npx --no-install turbo run typecheck test build --cache-dir="<isolated-cache-dir>" --dry=json --output-logs=hash-only
   ```

3. Run verification with that same directory. It must complete using local execution:

   ```text
   npm run verify -- --cache-dir="<isolated-cache-dir>"
   ```

4. Repeat the dry-run diagnosis. The same tasks should report `HIT` with source `LOCAL`.
5. On an approved environment, check out the same commit in a clean directory,
   enable the dedicated read-only credential, and use remote-read-only mode:

   ```text
   npx --no-install turbo run typecheck test build --cache-dir="<isolated-cache-dir>" --cache="local:rw,remote:r" --dry=json --output-logs=hash-only
   ```

   Existing artifacts for that exact commit should report source `REMOTE`.
6. Change a hashed source or configuration input. The affected task must report
   a miss and rebuild; an unrelated task may still hit.
7. If remote access is deliberately unavailable in a disposable environment,
   verify that the run reports the remote condition and still completes locally.

The authenticated remote-hit check is optional for contributors who do not have
the approved credential. The credentialless cache-cold and local-hit checks are
the required baseline.

### Validation record

The documented baseline was exercised on 2026-09-16 using an isolated temporary
cache directory and no `TURBO_TOKEN` or `TURBO_TEAM` in the environment. The
four-task count below is for the filtered build command shown here, not for the
full repository graph:

- `turbo run build --filter=@wispace/llm-agent` reported four tasks with `MISS`.
- Repeating that filtered build after execution reported four tasks with source
  `LOCAL`.
- The existing pull-request workflow secret-scoping regression test passed.
- Full verification with the quoted remote-read-only option passed with all
  scheduled Turbo tasks successful; without an approved credential Turbo
  correctly kept remote caching disabled and used local cache behavior. The
  exact task count is intentionally not recorded because the graph changes as
  packages are added.
- An authenticated `REMOTE` hit was not exercised because this environment has
  no approved developer credential. It remains an operator-side check for a
  clean checkout where a trusted artifact already exists.

## Branches and invalidation

Turbo hashes task inputs, not branch names. A valid artifact may be reused by a
different branch when its inputs produce the same hash. An input change must
invalidate the affected task. Do not create branch-specific namespaces or
delete shared cache state to force a check; use a temporary cache directory or
Turbo's force option for deliberate cold verification.

## Security boundary and residual risk

Local runs are not remote-cache writers. This prevents a compromised checkout
from deliberately uploading artifacts into the CI cache through a developer
workflow. A local read-only credential must still be separate from CI write
credentials so it can be revoked independently.

Remote-cache signing and artifact provenance are not implemented by this
workflow. Trusted CI remains the writer boundary, and the residual integrity
risk is recorded in the cache-boundary ADR. Revisit signing if untrusted
writers, stronger provenance requirements, or provider capabilities change.

## Troubleshooting

- **No remote credential**: this is supported. Run the default local workflow.
- **No remote hit**: check that the exact commit artifact exists, the approved
  team or namespace is selected, and the task hash matches.
- **Remote unavailable**: keep the local result if verification completes; report
  the remote condition separately from a normal miss.
- **Credential appeared in history or logs**: revoke it immediately and request
  a replacement. Do not copy it into a project file.
- **Need a cold run**: use a temporary cache directory or Turbo's force option;
  do not delete another developer's cache.

## CI regression guard

The existing pull-request workflow secret-scoping test remains the guard for
credential isolation. If a future change gives credentials to a new workflow
step, that guard must be updated in the same change and the trust decision must
be revisited.
