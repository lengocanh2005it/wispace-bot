# LLM context drop order

**Status: Accepted**

When one LLM input-token budget is tight, retain the current learner turn,
universal and platform safety rules, the identity/display-name block, and the
full tool schemas. Remove the optional learner-profile section first, then the
reasoning instruction, then the oldest replayed history entries. Do not infer a
tool subset from the learner's text; if the retained minimum still exceeds the
budget, use the existing fail-closed fallback. This preserves the freshest
conversation signal without weakening tool policy or safety context.
