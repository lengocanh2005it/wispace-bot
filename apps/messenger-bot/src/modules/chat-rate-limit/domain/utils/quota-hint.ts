export function shouldShowQuotaRemainingHint(
  remaining: number,
  threshold: number,
): boolean {
  return remaining > 0 && remaining <= threshold;
}
