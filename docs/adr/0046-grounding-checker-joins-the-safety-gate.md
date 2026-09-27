---
status: accepted
decided: 2026-09-27
issue: 1431
---

# The grounding checker joins the safety gate

The no-fabrication grounding check and the secret/harmful-output guards are one
pre/post-LLM gate that the safety pipeline reads together, so the grounding
checker lives in the safety directory rather than a directory of its own. This
is a statement about where the code is read from, not about what the check is:
the glossary keeps the grounding check distinct from the output guard, and
that distinction is unchanged.

## Context

#1429 dissolved the package's undifferentiated `utils/` directory into
purpose-named directories, and gave the no-fabrication grounding checker a
directory of its own so a contributor could find it from the folder name
alone. It deliberately wrote no architectural decision record, because a
reversible file move needs none.

The review of that issue raised the other side of the same argument. The
grounding checker had exactly one non-barrel consumer, and that consumer was
the safety pipeline, which imports the grounding checker and the final-output
guard on adjacent lines as the two halves of one gate. The split therefore
bought a directory name rather than a change boundary, and #1429 filed the
choice rather than making it.

The premise did not survive contact with the tree. `grounding/` held a single
module whose only production importer was `internal/safety-pipeline.ts`. A
directory named for a concept with one implementation and one importer is a
label; the change boundary the split was supposed to create did not exist.

## Outcome

The `grounding/` directory is dissolved and the checker moves into the safety
directory, renamed on arrival to match the sibling naming convention — the
package is already `llm-agent`, so no module in `safety/` carries an `llm-`
prefix. The rule covers filenames only; the exported symbols keep their `Llm`
prefix, because they are public through the `core` barrel. The rename is
performed in version control so the file's history follows it.

The two named review surfaces are the same surface: a change to the gate is
re-read in both checks at once, so the security reviewer and the grounding
reviewer are the same reader on the same day.

This is a file move, so it touches no behavior. No prompt content changes, so
the eval fixture prompt hashes stay valid and no re-approval cycle is
triggered. The public export surface is unchanged: the same symbols are
exported from the same subpaths under the same names, and the architecture
guard's framework-bound allowlist is untouched, because it never named a path
in this package.

The domain glossary is left alone. The move relocates a module between
directories without moving a concept across a boundary, so no glossary entry
changes — the same reasoning ADR-0044 applied to its own decomposition.

## Consequences

The cost of the merge is that the directory name is now a slightly lossy index
for one of its five modules, and the glossary carries the precision the folder
name no longer does.

Two documents elsewhere in the tree name the checker's old path. Both are
records of what a specific past change did, not inventories of the present, so
neither is edited to describe this later move. The migration plan's Phase 1
section still names a `openai-error.utils.ts` that #1438 had already removed,
which shows what that section records. The dated stale-issue audit is a scan
result whose columns are the old location, the new location at that time, and
the issues that cited it; it already anticipates this case when it says a
finding survives and only its citation goes stale.

## References

- [#1431](https://github.com/lengocanh2005it/wispace-bot/issues/1431)
- [#1429](https://github.com/lengocanh2005it/wispace-bot/issues/1429)
- [ADR-0044 — Decomposition is driven by duplicated responsibilities, not by
  file size](0044-decomposition-drivers-not-file-size.md)
