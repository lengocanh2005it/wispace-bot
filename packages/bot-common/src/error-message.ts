/** Extract a string message from any caught value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
