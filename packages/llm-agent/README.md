# `@wispace/llm-agent`

Shared LLM orchestration and deterministic chat eval tooling.

## Eval fixture prompt hashes

The JSON fixtures pin the LF-normalized SHA-256 hash of the shared prompt core and every referenced platform overlay. Keep existing hashes in a behavior PR; after that change is reviewed and merged, use a rebased hash-only rehash PR to refresh them and re-validate behavior.

For a dedicated hash-only rehash PR after the behavior change is reviewed and merged:

Build the package first, then update hashes:

```text
npm run build --workspace=@wispace/llm-agent
npm run eval:rehash
```

To verify hashes without changing fixtures:

```text
npm run eval:rehash:check
```

The command discovers every JSON fixture, rejects invalid or unsafe prompt references before writing, preserves fixture formatting, and is idempotent. It does not approve fixture behavior or call an LLM. Run the offline eval after a prompt change:

```text
npm run eval:chat --workspace=@wispace/llm-agent
```

CI runs the read-only check in the path-filtered guardrail-battery workflow; CI never rewrites fixtures.
