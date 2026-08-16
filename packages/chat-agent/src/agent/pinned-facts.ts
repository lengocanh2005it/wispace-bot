/**
 * Generic pinned-facts mechanism (#207 item 6): server-derived facts are
 * deterministically merged into the final reply, so a model that omits a
 * required fact (e.g. the created exercise URL) can never produce an
 * incomplete answer. Grounding-safe: facts come from tool results, the model
 * only decides the prose around them.
 */

export interface PinnedFact {
  /** Stable key — a fact already merged under this key is not re-appended. */
  key: string;
  /** The server-derived sentence to append (sanitized, learner-facing). */
  text: string;
}

/**
 * Appends facts that are not already present in the reply text. Idempotent
 * per text: if the model already included the fact's exact sentence, it is
 * not duplicated. Returns the trimmed original when there is nothing to add.
 */
export function pinFactsToReply(
  text: string,
  facts: readonly PinnedFact[],
): string {
  let result = text.trim();
  for (const fact of facts) {
    if (result.includes(fact.text)) {
      continue;
    }
    result = result ? `${result}\n\n${fact.text}` : fact.text;
  }
  return result;
}

/** Pinned fact for the precreated roadmap exercise URL (legacy behavior). */
export function buildExerciseUrlFact(url: string): PinnedFact {
  return { key: 'precreated_exercise_url', text: `Mở bài tập tại đây: ${url}` };
}
