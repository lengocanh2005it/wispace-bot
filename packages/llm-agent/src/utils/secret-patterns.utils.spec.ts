import {
  CREDENTIAL_SHAPES,
  findCredentialShape,
} from './secret-patterns.utils';

describe('CREDENTIAL_SHAPES (#632 input-side secret redaction)', () => {
  it('keeps the shapes the output guard already enforced', () => {
    const samples = [
      'key: sk-1234567890abcdef1234567890abcdef',
      'Authorization: Bearer abcdef1234567890abcd',
      'api_key = mysecretvalue123',
    ];

    for (const sample of samples) {
      expect(findCredentialShape(sample)).not.toBeNull();
    }
  });

  it('detects JWTs', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
    expect(findCredentialShape(`token ${jwt}`)).not.toBeNull();
    // Three dot-separated segments with the eyJ prefix — not a normal sentence.
    expect(
      findCredentialShape(
        'eyJhbGciOi.payload.SflKxwRJSMeKKF2QT4fwpMeJf36POk6y',
      ),
    ).not.toBeNull();
  });

  it('detects connection strings with embedded credentials', () => {
    const samples = [
      'postgres://admin:hunter2@db.example.com:5432/ai_chat_bot_db',
      'postgresql://user:pass@host/db',
      'redis://:s3cret@redis-1:6379',
      'mongodb://root:pw@cluster0.abc.mongodb.net/db',
    ];

    for (const sample of samples) {
      expect(findCredentialShape(sample)).not.toBeNull();
    }
  });

  it('does not flag ordinary chat content', () => {
    const samples = [
      'Mình muốn nâng band speaking lên 7.0 trước tháng 9',
      'sk12', // too short
      'Meeting at 09:00, bring the key to the room',
      'https://wispace.example.com/lesson?id=42',
    ];

    for (const sample of samples) {
      expect(findCredentialShape(sample)).toBeNull();
    }
  });

  it('exposes the patterns as the single source (output guard reuses them)', () => {
    expect(Array.isArray(CREDENTIAL_SHAPES)).toBe(true);
    expect(CREDENTIAL_SHAPES.length).toBeGreaterThanOrEqual(5);
  });
});
