# Head-and-tail sampling for oversized classifier input

**Status**: Accepted

For the Messenger-only second-tier classifier, send the full redacted learner message while it fits `LLM_INPUT_CLASSIFIER_MAX_INPUT_CHARS`; otherwise send one bounded head-and-tail sample with an omission marker. This closes the known tail-truncation bypass without multiplying provider calls under the classifier's single-call latency budget. Chunking was rejected for now because it increases cost and timeout pressure; the omitted middle remains an explicit blind spot, so sampling frequency is measured and the separate tier-one `message_too_long` policy remains owned by #1029.
