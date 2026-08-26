import { readResponseText } from './read-response-text';

describe('readResponseText', () => {
  it('truncates and cancels an oversized response body', async () => {
    const response = new Response('0123456789');

    await expect(readResponseText(response, 4)).resolves.toBe('0123');
  });

  it('rejects an invalid byte limit', async () => {
    await expect(readResponseText(new Response('ok'), 0)).rejects.toThrow(
      'maxBytes must be a positive safe integer',
    );
  });
});
