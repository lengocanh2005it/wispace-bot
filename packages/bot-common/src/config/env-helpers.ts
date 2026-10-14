/**
 * The only thing these readers need from whatever holds the environment.
 * Declared structurally rather than as a pick from the Nest config service, so
 * a file-level classifier does not report this module as framework-coupled
 * over a pure arithmetic helper (#1454).
 */
type ConfigReader = {
  get: <T>(key: string) => T | undefined;
};

/** Shared tolerant readers used by scheduled workers. */
export function readEnvBoolean(
  config: ConfigReader,
  key: string,
  fallback: boolean,
): boolean {
  const value = config.get<unknown>(key);
  const raw = value == null ? '' : String(value).trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  if (raw === 'false' || raw === '0' || raw === 'no') return false;
  return fallback;
}

export function readEnvPositiveInt(
  config: ConfigReader,
  key: string,
  fallback: number,
): number {
  const rawValue = config.get<unknown>(key);
  const raw = rawValue == null ? '' : String(rawValue).trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Read an explicit override that has no fallback: an absent or unusable value
 * means "derive it", not "use a default". Shared by the background producers
 * and by startup validation, so the deploy-time phase can never disagree with
 * the value the running application applies.
 */
export function readOptionalPositiveInt(
  get: (key: string) => string | undefined,
  key: string,
): number | undefined {
  const raw = get(key)?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
