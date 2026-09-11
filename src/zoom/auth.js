const TOKEN_URL = 'https://api.zoom.us/oauth/token';

/**
 * Server-to-Server OAuth credential cache.
 *
 * Access tokens live for 3600s and we refresh 300s early by default. A 60s
 * margin is enough in theory but leaves no room for a request that stalls near
 * the end of a long send loop — the cost of refreshing early is one HTTP call.
 *
 * Refreshes are single-flight: with CONCURRENCY > 1 a naive cache lets every
 * in-flight worker stampede the OAuth endpoint at the same moment.
 */
export function createCredentialProvider({
  accountId,
  clientId,
  clientSecret,
  marginSec = 300,
  timeoutMs = 15_000,
  logger,
}) {
  let cached = null;
  let inflight = null;

  async function fetchCredential() {
    const url = new URL(TOKEN_URL);
    url.searchParams.set('grant_type', 'account_credentials');
    url.searchParams.set('account_id', accountId);
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}` },
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = await res.text();
    if (!res.ok) {
      throw new Error(`Zoom OAuth failed: ${res.status} ${body.slice(0, 300)}`);
    }
    const data = JSON.parse(body);
    cached = {
      value: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
    };
    logger?.debug({ expiresIn: data.expires_in }, 'obtained zoom access credential');
    return cached.value;
  }

  return {
    async get() {
      if (cached && Date.now() < cached.expiresAt - marginSec * 1000) return cached.value;
      if (inflight) return inflight;
      inflight = fetchCredential().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    invalidate() {
      cached = null;
    },
  };
}
