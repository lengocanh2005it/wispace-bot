export function readHttpsUrl(
  value: unknown,
  errorMessage = 'invalid exercise URL',
): string {
  if (typeof value !== 'string') throw new Error(errorMessage);

  const url = value.trim();
  try {
    if (new URL(url).protocol !== 'https:') throw new Error();
  } catch {
    throw new Error(errorMessage);
  }

  return url;
}
