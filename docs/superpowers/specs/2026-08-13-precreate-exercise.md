# Create Next Roadmap Exercise — Feature Spec

Date: 2026-08-13
Status: agreed during domain modeling

## Goal

Let a linked learner ask any of the Messenger, Discord, or Zalo bots to create the next exercise from the learner's WISPACE roadmap and receive the practice URL.

## Scope

- Trigger only from a sufficiently clear natural-language request such as “tạo bài tập cho mình” or “cho mình bài tập mới”. No menu or postback is added.
- Add one LLM tool named precreate_next_exercise with no arguments.
- The tool only creates the next roadmap exercise. It does not accept taskType, exerciseTopic, difficulty, or any other exercise-selection input.
- The bot calls the feature only for a linked account. An unlinked learner receives the existing platform-specific linking message and the WISPACE API is not called.
- The bot sends the returned practice URL. It does not track clicks, attempts, completion, or add a reminder/outbox record.

## WISPACE API contract

POST WISPACE_API_PRECREATE_EXERCISE_URL with an empty body and these headers:

- Messenger: x-psid = externalUserId
- Discord: x-discordid = externalUserId
- Zalo: x-zaloid = externalUserId
- All platforms: X-Internal-Key = WISPACE_INTERNAL_KEY

The endpoint is idempotent. Repeating a request for the same roadmap position does not create a duplicate; WISPACE returns alreadyExists=true with the existing URL.

The expected response is:

    {
      "hasRoadmap": true,
      "finishedAllExercises": false,
      "alreadyExists": false,
      "exerciseUrl": "https://testfrontend.aihubproduction.com/my-roadmap?sequenceIndex=8",
      "message": "Exercise for node 8 was successfully generated. Click the link to practice!"
    }

The bot maps the flags in this order:

1. hasRoadmap=false → no_roadmap.
2. finishedAllExercises=true → finished_all.
3. alreadyExists=true → already_exists.
4. Otherwise → created.

For created and already_exists, exerciseUrl must be an absolute HTTPS URL. A missing or invalid URL makes the response invalid. The bot accepts the URL's host without an application allowlist so test and production frontend hosts can change without a code release.

The flags are authoritative. message is optional advisory context: it is trimmed, length-limited, sanitized for LLM use, and exposed as messageHint; it never overrides the flags and is never sent verbatim to the learner.

## Failure and timeout behavior

- API request timeout: WISPACE_API_PRECREATE_EXERCISE_TIMEOUT_MS=30000.
- LLM tool execution timeout: 35 seconds on all three bots.
- The POST is never automatically retried. This avoids a second side effect when the first request may have succeeded but its response was lost.
- Any non-2xx response, timeout, network error, invalid JSON, invalid flags, or invalid required URL returns a generic Vietnamese failure result. Raw status/body is not sent to the learner or LLM.
- If WISPACE created the exercise but the final LLM reply times out, a later learner request can safely retrieve the existing URL because the endpoint is idempotent.

## Reply behavior

The existing LLM tool round writes the natural Vietnamese response. Prompts must require the exact validated URL whenever one is returned and must state that the tool only creates the next roadmap exercise. If the final LLM text omits the URL, the shared platform agent appends a deterministic fallback containing the exact URL.

The tool marks the context as private data. A Discord request made in a server channel is therefore delivered through the existing DM/private-data path.

## Out of scope / future extension

No database state, outbox, cooldown, quota bucket, menu, click tracking, or custom exercise selection is added. When WISPACE adds taskType and exerciseTopic parameters, a separate extension can support requests for a specific exercise type or topic.

## Acceptance criteria

- All three platform headers and the shared internal key are covered by tests.
- The request is a POST with no body and no automatic retry.
- Tests cover all four statuses, precedence, HTTPS URL validation, advisory-message sanitization, malformed responses, and generic errors.
- An unlinked account never calls WISPACE.
- A linked account marks private data as fetched and uses the platform's externalUserId, including Zalo.
- A final response without the validated URL receives the code fallback.
- Root format check, lint, typecheck, test, and build pass.
