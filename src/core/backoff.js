/**
 * Retry-After comes in two shapes and mixing them up fails silently:
 *   - delta-seconds, e.g. "2"                     (the normal case for QPS limits)
 *   - an absolute date, e.g. "2026-09-12T00:00:00Z" or an HTTP-date
 * Number("2026-09-12T00:00:00Z") is NaN, so a seconds-only parser would just
 * drop the hint and retry too early. Always normalise to a Date.
 */
export function parseRetryAfter(value, now = Date.now()) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return new Date(now + Number(raw) * 1000);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Exponential backoff with full jitter: delay = random(0, min(cap, base * 2^n)).
 * Full jitter (rather than equal jitter) is what breaks up a herd of retries
 * that were all throttled by the same 429.
 */
export function computeDelayMs(attempt, { baseMs, maxMs, random = Math.random }) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.round(random() * ceiling);
}

/**
 * @param attempt number of attempts already made (0 => first retry)
 * @param retryAfter Date | null — server hint, honoured as a floor
 */
export function nextAttemptAt({ attempt, retryAfter, baseMs, maxMs, now = Date.now(), random }) {
  const backoffAt = now + computeDelayMs(attempt, { baseMs, maxMs, random });
  const hintAt = retryAfter ? retryAfter.getTime() : 0;
  return new Date(Math.max(backoffAt, hintAt));
}
