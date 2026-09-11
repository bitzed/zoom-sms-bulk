const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Adaptive token bucket (AIMD) for the Zoom Phone SMS endpoint.
 *
 * The endpoint sits in the Medium rate-limit tier: 10 req/s on Pro, 20 req/s on
 * Business and above. We default the ceiling to 80% of nominal because the same
 * account quota is shared with everything else hitting the API — dashboards,
 * other scripts, other apps. Pinning 100% makes *us* the reason someone else
 * gets throttled.
 *
 * Headers are read from successful responses too, not just 429s: by the time a
 * 429 arrives the queue behind us is already backing up.
 */
export function createGovernor({
  ceiling,
  lowWaterRatio = 0.2,
  recoverAfter = 50,
  minRate = 0.5,
  now = () => Date.now(),
  onChange = () => {},
}) {
  let rate = ceiling;
  let tokens = ceiling;
  let lastRefill = now();
  let successStreak = 0;
  let lastAdjustment = null;

  const capacity = () => Math.max(1, rate);

  function refill() {
    const t = now();
    tokens = Math.min(capacity(), tokens + ((t - lastRefill) / 1000) * rate);
    lastRefill = t;
  }

  function setRate(next, reason) {
    const clamped = Math.max(minRate, Math.min(ceiling, next));
    if (Math.abs(clamped - rate) < 1e-6) return;
    rate = clamped;
    tokens = Math.min(tokens, capacity());
    lastAdjustment = { reason, rate, at: new Date().toISOString() };
    onChange(lastAdjustment);
  }

  return {
    /** Blocks until one request may be issued. */
    async acquire() {
      for (;;) {
        refill();
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        const waitMs = Math.ceil(((1 - tokens) / rate) * 1000);
        await sleep(Math.min(Math.max(waitMs, 5), 1000));
      }
    },

    /** Feed in X-RateLimit-* from any response, success or failure. */
    observe({ limit, remaining } = {}) {
      if (!limit || remaining == null) return;
      if (remaining < limit * lowWaterRatio) {
        successStreak = 0;
        setRate(rate / 2, `remaining ${remaining}/${limit} below ${lowWaterRatio * 100}%`);
      }
    },

    /** A request came back 2xx. */
    success() {
      if (++successStreak >= recoverAfter) {
        successStreak = 0;
        setRate(rate * 1.1, 'recovering after sustained success');
      }
    },

    /** A request was throttled (429 with a per-second limit). */
    throttled() {
      successStreak = 0;
      setRate(rate / 2, 'throttled by 429');
    },

    stats() {
      return { rate: Math.round(rate * 100) / 100, ceiling, lastAdjustment };
    },
  };
}
