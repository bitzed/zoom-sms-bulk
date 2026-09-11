import { parseRetryAfter } from '../core/backoff.js';

const SMS_URL = 'https://api.zoom.us/v2/phone/sms/messages';

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function readRateHeaders(headers, now) {
  return {
    limit: num(headers.get('x-ratelimit-limit')),
    remaining: num(headers.get('x-ratelimit-remaining')),
    type: headers.get('x-ratelimit-type'),
    retryAfter: parseRetryAfter(headers.get('retry-after'), now),
  };
}

/**
 * Classifies an HTTP status into what the runner should do next.
 *
 * The distinction that matters: a terminal 4xx costs nothing to give up on,
 * while retrying one burns rate-limit budget that other recipients need.
 */
function classify(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 429 || status === 408 || status >= 500) return 'retryable';
  return 'terminal';
}

export function createSmsClient({ credentials, timeoutMs = 15_000, dryRun = false, logger }) {
  async function post(body, token) {
    return fetch(SMS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  return {
    /**
     * Never throws. Every outcome is normalised into the same shape so the
     * runner has exactly one code path to reason about.
     */
    async send({ sender, phone, message }) {
      const startedAt = new Date().toISOString();
      const t0 = Date.now();
      const base = { startedAt, rate: {}, trackingId: null, zoomCode: null };

      if (dryRun) {
        await new Promise((r) => setTimeout(r, 80 + Math.random() * 120));
        return {
          ...base,
          kind: 'ok',
          httpStatus: 201,
          messageId: `dry-${Math.random().toString(16).slice(2, 10)}`,
          sessionId: 'dry-run',
          latencyMs: Date.now() - t0,
        };
      }

      const payload = {
        message,
        sender: { phone_number: sender },
        to_members: [{ phone_number: phone }],
      };

      let res;
      try {
        let token;
        try {
          token = await credentials.get();
        } catch (err) {
          // Bad account id, client id or secret. Every recipient would fail the
          // same way, so this is a configuration problem, not a flaky call.
          return {
            ...base,
            kind: 'config',
            httpStatus: null,
            error: String(err?.message ?? err),
            latencyMs: Date.now() - t0,
          };
        }

        res = await post(payload, token);

        // An expired credential is not a send failure: refresh once and retry
        // immediately without consuming one of the recipient's attempts.
        if (res.status === 401) {
          credentials.invalidate();
          token = await credentials.get();
          res = await post(payload, token);
        }
      } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        return {
          ...base,
          // A timeout is *not* a failure to send — the request may well have
          // reached Zoom. Retrying it automatically risks a double send, so the
          // runner parks it for a human to decide.
          kind: timedOut ? 'ambiguous' : 'retryable',
          httpStatus: null,
          error: timedOut ? `request timed out after ${timeoutMs}ms` : String(err?.message ?? err),
          latencyMs: Date.now() - t0,
        };
      }

      const now = Date.now();
      const rate = readRateHeaders(res.headers, now);
      const trackingId = res.headers.get('x-zm-trackingid');
      const text = await res.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON error page */
      }

      // Still 401 after a forced refresh: the credential itself is not usable
      // for this call (wrong scope, wrong account), so stop the job.
      const kind = res.status === 401 ? 'config' : classify(res.status);
      const result = {
        startedAt,
        kind,
        httpStatus: res.status,
        zoomCode: body?.code ?? null,
        rate,
        trackingId,
        latencyMs: Date.now() - t0,
      };

      if (kind === 'ok') {
        return {
          ...result,
          messageId: body?.message_id ?? null,
          sessionId: body?.session_id ?? null,
        };
      }

      result.error = body?.message ?? text.slice(0, 300) ?? `HTTP ${res.status}`;
      logger?.debug({ status: res.status, code: result.zoomCode, trackingId }, 'sms send failed');
      return result;
    },
  };
}
