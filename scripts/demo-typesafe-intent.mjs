// Demo: TypeSafe System One (Jev) — intent classification for wispace-bot chat
// Usage:  $env:TYPESAFE_API_KEY = "..." ; node scripts/demo-typesafe-intent.mjs
// NOTE: key via env var only — never hardcode or commit.

const API_KEY = process.env.TYPESAFE_API_KEY;
if (!API_KEY) {
  console.error('Missing TYPESAFE_API_KEY env var');
  process.exit(2);
}

const learnerMessage =
  'Em ơi bot, lịch học IELTS của em tuần sau có buổi nào không ạ?';

const request = {
  state: learnerMessage,
  model: 'jev-latest',
  questions: {
    intent: {
      type: 'choice',
      instructions:
        'What is the learner asking about in this Vietnamese message?',
      criteria: {
        study_schedule: 'Asking about study sessions, calendar, or class times',
        learning_progress: 'Asking about scores, progress, or skill assessment',
        new_exercise: 'Requesting a new exercise or practice task',
        general_chat: 'Greeting, small talk, or an unrelated question',
      },
    },
    needs_urgent_reply: {
      type: 'noul',
      instructions:
        'Does this message require an urgent, time-sensitive response?',
      criteria: {
        true: 'Time-sensitive: deadline, same-day urgency, or distress',
        false: 'A normal question with no urgency',
      },
    },
  },
};

const resp = await fetch('https://api.typesafe.ai/v1/systemone', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(request),
});

if (!resp.ok) {
  console.error(`HTTP ${resp.status}:`, await resp.text());
  process.exit(1);
}

const data = await resp.json();

console.log('--- Input ---');
console.log(learnerMessage);
console.log('\n--- Answers ---');
const { intent, needs_urgent_reply } = data.answers;
console.log(
  `intent:            ${intent.choice} (confidence ${intent.confidence})`,
);
console.log('  probabilities:  ', intent.probabilities);
console.log(
  `needs_urgent_reply: ${(needs_urgent_reply.noul * 100).toFixed(1)}% yes`,
);
console.log('\n--- Usage ---');
console.log(data.usage);

// Confidence-gated routing (pattern from TypeSafe docs)
console.log('\n--- Code-side routing decision ---');
if (intent.confidence < 0.6) {
  console.log(
    'LOW confidence → fall back to free-form LLM chat (no tool call)',
  );
} else {
  console.log(`Route to handler: ${intent.choice}`);
}
