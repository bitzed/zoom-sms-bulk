import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseRetryAfter, computeDelayMs, nextAttemptAt } from '../src/core/backoff.js';
import { resolveMountPoint } from '../src/config.js';
import { createGovernor } from '../src/core/governor.js';
import { analyze, render, placeholders } from '../src/core/template.js';
import { parseRecipients, maskPhone } from '../src/core/parse.js';
import { openStore } from '../src/core/store.js';
import { createRunner } from '../src/core/runner.js';
import { createSmsClient } from '../src/zoom/sms.js';

// ------------------------------------------------------------- backoff

test('parseRetryAfter accepts delta-seconds', () => {
  const now = 1_000_000;
  assert.equal(parseRetryAfter('2', now).getTime(), now + 2000);
});

test('parseRetryAfter accepts an absolute timestamp', () => {
  // Observed from Zoom on a daily-limit 429: an ISO date, not a number.
  const at = parseRetryAfter('2026-09-12T00:00:00Z', 0);
  assert.equal(at.toISOString(), '2026-09-12T00:00:00.000Z');
});

test('parseRetryAfter ignores junk instead of producing NaN', () => {
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter(null), null);
});

test('computeDelayMs stays within the full-jitter window and respects the cap', () => {
  const opts = { baseMs: 1000, maxMs: 60_000 };
  for (const attempt of [0, 1, 2, 3, 4, 10]) {
    const ceiling = Math.min(opts.maxMs, 1000 * 2 ** attempt);
    for (let i = 0; i < 50; i++) {
      const d = computeDelayMs(attempt, opts);
      assert.ok(d >= 0 && d <= ceiling, `attempt ${attempt} gave ${d}, ceiling ${ceiling}`);
    }
  }
  assert.equal(computeDelayMs(20, { ...opts, random: () => 1 }), 60_000);
});

test('nextAttemptAt uses the server hint as a floor', () => {
  const now = 1_000_000;
  const hint = new Date(now + 30_000);
  const at = nextAttemptAt({
    attempt: 0,
    retryAfter: hint,
    baseMs: 1000,
    maxMs: 60_000,
    now,
    random: () => 0,
  });
  assert.equal(at.getTime(), hint.getTime());
});

// ------------------------------------------------- container volume guard

// Verbatim shape of /proc/self/mountinfo inside `docker run` with no -v.
const MOUNTINFO_NO_VOLUME = `
1234 1233 0:100 / / rw,relatime master:1 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/AAA
1235 1234 0:103 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
1236 1234 0:104 / /dev rw,nosuid - tmpfs tmpfs rw,size=65536k,mode=755
1237 1234 0:105 / /sys ro,nosuid,nodev,noexec,relatime - sysfs sysfs ro
1250 1236 0:102 /0 /dev/console rw,nosuid,noexec,relatime - devpts devpts rw
`;

// The same container started with: -v "$PWD/data:/data"
const MOUNTINFO_WITH_VOLUME = `${MOUNTINFO_NO_VOLUME}
1260 1234 259:1 /Users/x/app/data /data rw,relatime - ext4 /dev/vda1 rw
`;

test('mount detection: an unmounted /data resolves to the container overlay', () => {
  assert.equal(resolveMountPoint(MOUNTINFO_NO_VOLUME, '/data'), '/');
});

test('mount detection: a bind-mounted /data resolves to itself', () => {
  assert.equal(resolveMountPoint(MOUNTINFO_WITH_VOLUME, '/data'), '/data');
});

test('mount detection: a path below the volume still resolves to the volume', () => {
  assert.equal(resolveMountPoint(MOUNTINFO_WITH_VOLUME, '/data/sms.db'), '/data');
});

test('mount detection: the longest matching mount wins, not the first', () => {
  // /data/sub must not be mistaken for /data when both are mounted.
  const nested = `${MOUNTINFO_WITH_VOLUME}
1270 1260 259:2 / /data/sub rw,relatime - ext4 /dev/vdb1 rw
`;
  assert.equal(resolveMountPoint(nested, '/data/sub/x'), '/data/sub');
});

test('mount detection: a similarly named sibling is not treated as a parent', () => {
  // "/data" must not match "/database" by a naive startsWith.
  assert.equal(resolveMountPoint(MOUNTINFO_WITH_VOLUME, '/database'), '/');
});

test('mount detection: unreadable mountinfo yields no mount point', () => {
  assert.equal(resolveMountPoint('', '/data'), null);
});

// ------------------------------------------------------------ governor

test('governor halves the rate when remaining runs low and recovers slowly', () => {
  const g = createGovernor({ ceiling: 8, recoverAfter: 3 });
  assert.equal(g.stats().rate, 8);

  g.observe({ limit: 100, remaining: 5 });
  assert.equal(g.stats().rate, 4);

  g.observe({ limit: 100, remaining: 90 });
  assert.equal(g.stats().rate, 4, 'healthy headroom must not change the rate');

  for (let i = 0; i < 3; i++) g.success();
  assert.equal(g.stats().rate, 4.4);

  g.throttled();
  assert.equal(g.stats().rate, 2.2);
});

test('governor never exceeds its ceiling', () => {
  const g = createGovernor({ ceiling: 8, recoverAfter: 1 });
  for (let i = 0; i < 100; i++) g.success();
  assert.equal(g.stats().rate, 8);
});

test('governor actually paces requests', async () => {
  const g = createGovernor({ ceiling: 20 });
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) await g.acquire();
  // 40 requests at 20/s with a 20-token burst allowance: at least ~1s.
  assert.ok(Date.now() - t0 >= 900, `took ${Date.now() - t0}ms`);
});

// ------------------------------------------------------------ template

test('analyze counts Japanese text as UCS-2 with 70 chars per segment', () => {
  const a = analyze('こんにちは');
  assert.equal(a.encoding, 'UCS-2');
  assert.equal(a.segments, 1);
  assert.equal(analyze('あ'.repeat(71)).segments, 2);
});

test('analyze counts plain ASCII as GSM-7', () => {
  assert.equal(analyze('Hello').encoding, 'GSM-7');
  assert.equal(analyze('a'.repeat(160)).segments, 1);
  assert.equal(analyze('a'.repeat(161)).segments, 2);
});

test('render substitutes placeholders and blanks unknown ones', () => {
  assert.equal(render('Hi {{name}}, {{slot}}', { name: '田中' }), 'Hi 田中, ');
  assert.deepEqual(placeholders('{{a}} {{b}} {{a}}'), ['a', 'b']);
});

// --------------------------------------------------------------- parse

test('parseRecipients normalises JP local numbers to E.164', () => {
  const r = parseRecipients('090-1234-5678\n08012345678');
  assert.deepEqual(
    r.rows.map((x) => x.phone),
    ['+819012345678', '+818012345678']
  );
  assert.equal(r.format, 'list');
});

test('parseRecipients treats local and E.164 spellings of one number as duplicates', () => {
  const r = parseRecipients('+818012345678\n08012345678');
  assert.equal(r.rows.length, 1);
  assert.equal(r.duplicates.length, 1);
});

test('parseRecipients reads CSV headers and keeps the other columns as vars', () => {
  const r = parseRecipients('phone,name,slot\n+818012345678,田中,10:00');
  assert.equal(r.format, 'csv-header');
  assert.deepEqual(r.rows[0].vars, { name: '田中', slot: '10:00' });
});

test('parseRecipients reports invalid rows instead of dropping them', () => {
  const r = parseRecipients('+818012345678\nnope\n');
  assert.equal(r.rows.length, 1);
  assert.equal(r.invalid.length, 1);
  assert.equal(r.invalid[0].reason, 'not_a_valid_number');
});

test('parseRecipients honours the do-not-contact list', () => {
  const r = parseRecipients('+818012345678\n+819012345678', {
    dnc: new Set(['+819012345678']),
  });
  assert.equal(r.rows.length, 1);
  assert.equal(r.blocked[0].phone, '+819012345678');
});

// The compose screen mirrors this naming in the browser to tell the operator,
// live, which {{placeholders}} their recipient list can actually fill.
test('parseRecipients reports the columns a header CSV offers', () => {
  const r = parseRecipients('phone,name,slot\n+818012345678,田中,10:00');
  assert.deepEqual(r.columns, ['name', 'slot']);
});

test('parseRecipients names headerless CSV columns col2, col3, …', () => {
  const r = parseRecipients('+818012345678,田中,10:00');
  assert.equal(r.format, 'csv');
  assert.deepEqual(r.columns, ['col2', 'col3']);
  assert.deepEqual(r.rows[0].vars, { col2: '田中', col3: '10:00' });
});

test('parseRecipients offers no columns for a plain list of numbers', () => {
  assert.deepEqual(parseRecipients('+818012345678\n090-1234-5678').columns, []);
});

test('maskPhone keeps only the country prefix and last four digits', () => {
  assert.equal(maskPhone('+818012345678'), '+8180****5678');
});

// -------------------------------------------------------------- runner

function harness({ responses, retry = {}, concurrency = 1 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsb-test-'));
  const store = openStore(path.join(dir, 'test.db'));
  const calls = [];
  const sms = {
    async send({ phone }) {
      calls.push(phone);
      const queue = responses[phone];
      const res = Array.isArray(queue) ? (queue.shift() ?? queue.at(-1)) : queue;
      return { startedAt: new Date().toISOString(), latencyMs: 1, rate: {}, ...res };
    },
  };
  const config = {
    retry: { maxAttempts: 3, baseMs: 5, maxMs: 20, circuitThreshold: 99, ...retry },
    safety: { quietHours: null },
  };
  const runner = createRunner({
    store,
    sms,
    governor: createGovernor({ ceiling: 1000 }),
    config,
  });
  const cleanup = () => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { store, runner, calls, concurrency, cleanup };
}

function seed(store, phones, concurrency = 1) {
  return store.createJob({
    operator: 'tester',
    agreedAt: new Date().toISOString(),
    sender: '+818000000000',
    template: 'hi {{name}}',
    concurrency,
    dryRun: false,
    rows: phones.map((phone, i) => ({ seq: i + 1, phone, vars: { name: `n${i}` } })),
  });
}

test('runner retries a 429 and succeeds on the next attempt', async (t) => {
  const h = harness({
    responses: {
      '+818000000001': [
        { kind: 'retryable', httpStatus: 429, error: 'rate limited', rate: { type: 'QPS' } },
        { kind: 'ok', httpStatus: 201, messageId: 'm1', sessionId: 's1' },
      ],
    },
  });
  t.after(h.cleanup);

  const jobId = seed(h.store, ['+818000000001']);
  await h.runner.start(jobId);

  const [r] = h.store.listRecipients(jobId);
  assert.equal(r.status, 'accepted');
  assert.equal(r.attempts, 2);
  assert.equal(r.message_id, 'm1');
  assert.equal(h.store.getJob(jobId).status, 'done');
  assert.equal(h.store.attemptsFor(r.id).length, 2);
});

test('runner gives up after MAX_ATTEMPTS', async (t) => {
  const h = harness({
    responses: {
      '+818000000001': { kind: 'retryable', httpStatus: 503, error: 'upstream down' },
    },
    retry: { maxAttempts: 3 },
  });
  t.after(h.cleanup);

  const jobId = seed(h.store, ['+818000000001']);
  await h.runner.start(jobId);

  const [r] = h.store.listRecipients(jobId);
  assert.equal(r.status, 'failed');
  assert.equal(r.attempts, 3);
  assert.match(r.last_error, /gave up after 3 attempts/);
});

test('runner never retries a permanent 4xx', async (t) => {
  const h = harness({
    responses: {
      '+818000000001': { kind: 'terminal', httpStatus: 400, error: 'invalid phone number' },
    },
  });
  t.after(h.cleanup);

  const jobId = seed(h.store, ['+818000000001']);
  await h.runner.start(jobId);

  assert.equal(h.store.listRecipients(jobId)[0].status, 'failed');
  assert.equal(h.calls.length, 1, 'a terminal error must not consume rate-limit budget');
});

test('a timeout becomes unknown rather than a silent double send', async (t) => {
  const h = harness({
    responses: {
      '+818000000001': { kind: 'ambiguous', httpStatus: null, error: 'request timed out' },
    },
  });
  t.after(h.cleanup);

  const jobId = seed(h.store, ['+818000000001']);
  await h.runner.start(jobId);

  assert.equal(h.store.listRecipients(jobId)[0].status, 'unknown');
  assert.equal(h.calls.length, 1);
});

test('a 403 pauses the whole job instead of burning the list', async (t) => {
  const h = harness({
    responses: {
      '+818000000001': { kind: 'terminal', httpStatus: 403, error: 'no permission' },
      '+818000000002': { kind: 'ok', httpStatus: 201, messageId: 'm2' },
      '+818000000003': { kind: 'ok', httpStatus: 201, messageId: 'm3' },
    },
  });
  t.after(h.cleanup);

  const jobId = seed(h.store, ['+818000000001', '+818000000002', '+818000000003']);
  await h.runner.start(jobId);

  const job = h.store.getJob(jobId);
  assert.equal(job.status, 'paused');
  assert.equal(job.pause_reason, 'config_error');
  assert.equal(h.store.counts(jobId).pending, 2, 'remaining recipients stay untouched');
});

test('a credential failure pauses immediately without spending attempts', async (t) => {
  const phones = ['+818000000001', '+818000000002', '+818000000003'];
  const h = harness({
    responses: Object.fromEntries(
      phones.map((p) => [p, { kind: 'config', httpStatus: null, error: 'Zoom OAuth failed: 400' }])
    ),
  });
  t.after(h.cleanup);

  const jobId = seed(h.store, phones);
  await h.runner.start(jobId);

  const job = h.store.getJob(jobId);
  assert.equal(job.status, 'paused');
  assert.equal(job.pause_reason, 'config_error');
  assert.equal(h.calls.length, 1, 'one call is enough to know the whole job is misconfigured');
  assert.equal(h.store.counts(jobId).pending, 3, 'nothing is consumed, so resuming re-sends nothing twice');
  assert.equal(h.store.listRecipients(jobId)[0].attempts, 0);
});

test('the circuit breaker stops a job that is failing every send', async (t) => {
  const h = harness({
    responses: Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `+81800000${String(i).padStart(4, '0')}`,
        { kind: 'terminal', httpStatus: 400, error: 'bad' },
      ])
    ),
    retry: { circuitThreshold: 3 },
  });
  t.after(h.cleanup);

  const jobId = seed(
    h.store,
    Array.from({ length: 10 }, (_, i) => `+81800000${String(i).padStart(4, '0')}`)
  );
  await h.runner.start(jobId);

  assert.equal(h.store.getJob(jobId).pause_reason, 'circuit');
  assert.ok(h.calls.length < 10, `stopped after ${h.calls.length} of 10`);
});

test('recipients are dispatched in input order', async (t) => {
  const phones = Array.from({ length: 8 }, (_, i) => `+81800000${String(i).padStart(4, '0')}`);
  const h = harness({
    responses: Object.fromEntries(phones.map((p) => [p, { kind: 'ok', httpStatus: 201 }])),
  });
  t.after(h.cleanup);

  const jobId = seed(h.store, phones);
  await h.runner.start(jobId);
  assert.deepEqual(h.calls, phones);
});

test('a job survives a restart without re-sending anything', async (t) => {
  const h = harness({
    responses: {
      '+818000000001': { kind: 'ok', httpStatus: 201, messageId: 'm1' },
      '+818000000002': { kind: 'ok', httpStatus: 201, messageId: 'm2' },
    },
  });
  t.after(h.cleanup);

  const jobId = seed(h.store, ['+818000000001', '+818000000002']);
  await h.runner.start(jobId);

  // Simulate a crash mid-flight on a fresh recipient, then a boot.
  h.store.db.exec(
    `UPDATE recipients SET status = 'sending' WHERE phone = '+818000000002'`
  );
  const recovered = h.store.recoverFromCrash();
  assert.equal(recovered.recipients, 1);

  const rows = h.store.listRecipients(jobId);
  assert.equal(rows[0].status, 'accepted');
  assert.equal(rows[1].status, 'unknown', 'in-flight at crash time is unknowable, not retryable');
});

test('requeue picks up failed and unknown recipients only', async (t) => {
  const h = harness({
    responses: {
      '+818000000001': { kind: 'ok', httpStatus: 201, messageId: 'm1' },
      '+818000000002': [
        { kind: 'terminal', httpStatus: 400, error: 'bad' },
        { kind: 'ok', httpStatus: 201, messageId: 'm2' },
      ],
    },
  });
  t.after(h.cleanup);

  const jobId = seed(h.store, ['+818000000001', '+818000000002']);
  await h.runner.start(jobId);
  assert.equal(h.store.counts(jobId).failed, 1);

  assert.equal(h.store.requeueFailed(jobId), 1);
  await h.runner.start(jobId);

  const counts = h.store.counts(jobId);
  assert.equal(counts.accepted, 2);
  assert.equal(h.calls.filter((p) => p === '+818000000001').length, 1, 'no double send');
});

// -------------------------------------------------- delivery status

function deliveryStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsb-deliv-'));
  const store = openStore(path.join(dir, 'test.db'));
  const jobId = store.createJob({
    operator: 'tester',
    agreedAt: new Date().toISOString(),
    sender: '+818000000000',
    template: 'hi',
    concurrency: 1,
    dryRun: false,
    rows: [
      { seq: 1, phone: '+818000000001', vars: {} },
      { seq: 2, phone: '+818000000002', vars: {} },
      { seq: 3, phone: '+818000000003', vars: {} },
    ],
  });
  return { store, jobId, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('recipientsNeedingDelivery lists only accepted, unsettled real sends', (t) => {
  const h = deliveryStore();
  t.after(h.cleanup);
  const [r1, r2, r3] = h.store.listRecipients(h.jobId);

  h.store.markAccepted(r1.id, { messageId: 'm1', sessionId: 's1' }); // needs a check
  h.store.markAccepted(r2.id, { messageId: 'm2', sessionId: 's2' });
  h.store.setDeliveryStatus(r2.id, 'delivered');                     // settled, skip
  h.store.markTerminal(r3.id, 'failed', 'bad number');               // never accepted

  const need = h.store.recipientsNeedingDelivery(h.jobId);
  assert.deepEqual(need.map((r) => r.seq), [1]);
});

test('recipientsNeedingDelivery re-checks a non-terminal delivery status', (t) => {
  const h = deliveryStore();
  t.after(h.cleanup);
  const [r1] = h.store.listRecipients(h.jobId);
  h.store.markAccepted(r1.id, { messageId: 'm1', sessionId: 's1' });
  h.store.setDeliveryStatus(r1.id, 'sent'); // not terminal — still worth polling
  assert.deepEqual(h.store.recipientsNeedingDelivery(h.jobId).map((r) => r.seq), [1]);
});

test('recipientsNeedingDelivery ignores dry-run sessions', (t) => {
  const h = deliveryStore();
  t.after(h.cleanup);
  const [r1] = h.store.listRecipients(h.jobId);
  h.store.markAccepted(r1.id, { messageId: 'dry-x', sessionId: 'dry-run' });
  assert.equal(h.store.recipientsNeedingDelivery(h.jobId).length, 0);
});

test('deliveryCounts buckets statuses for the tiles', (t) => {
  const h = deliveryStore();
  t.after(h.cleanup);
  const [r1, r2, r3] = h.store.listRecipients(h.jobId);
  for (const r of [r1, r2, r3]) h.store.markAccepted(r.id, { messageId: 'm', sessionId: 's' });
  h.store.setDeliveryStatus(r1.id, 'delivered');
  h.store.setDeliveryStatus(r2.id, 'undelivered');
  // r3 left unchecked
  const c = h.store.deliveryCounts(h.jobId);
  assert.equal(c.delivered, 1);
  assert.equal(c.undelivered, 1);
  assert.equal(c.unchecked, 1);
  assert.equal(c.accepted, 3);
});

function smsWithFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  const client = createSmsClient({
    credentials: { get: async () => 'tok', invalidate() {} },
    timeoutMs: 1000,
  });
  return { client, restore: () => { globalThis.fetch = original; } };
}

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('fetchDelivery reads delivery_status from a single-message payload', async (t) => {
  const { client, restore } = smsWithFetch(async (url) => {
    assert.match(String(url), /\/sessions\/s1\/messages\/m1$/);
    return jsonResponse(200, { message_id: 'm1', direction: 'Out', delivery_status: 'delivered' });
  });
  t.after(restore);
  const d = await client.fetchDelivery({ sessionId: 's1', messageId: 'm1' });
  assert.equal(d.ok, true);
  assert.equal(d.deliveryStatus, 'delivered');
});

test('fetchDelivery falls back to sms_histories if a session payload comes back', async (t) => {
  const { client, restore } = smsWithFetch(async () =>
    jsonResponse(200, {
      sms_histories: [
        { message_id: 'other', delivery_status: 'undelivered' },
        { message_id: 'm1', delivery_status: 'delivered' },
      ],
    })
  );
  t.after(restore);
  const d = await client.fetchDelivery({ sessionId: 's1', messageId: 'm1' });
  assert.equal(d.deliveryStatus, 'delivered');
});

test('fetchDelivery never calls the API for dry-run or missing ids', async (t) => {
  let called = false;
  const { client, restore } = smsWithFetch(async () => { called = true; return jsonResponse(200, {}); });
  t.after(restore);
  assert.equal((await client.fetchDelivery({ sessionId: 'dry-run', messageId: 'x' })).ok, false);
  assert.equal((await client.fetchDelivery({ sessionId: null, messageId: 'x' })).ok, false);
  assert.equal(called, false, 'dry-run and missing ids must not hit the network');
});

test('fetchDelivery reports an HTTP error without throwing', async (t) => {
  const { client, restore } = smsWithFetch(async () => jsonResponse(404, { code: 7013, message: 'SMS session does not exist' }));
  t.after(restore);
  const d = await client.fetchDelivery({ sessionId: 's1', messageId: 'm1' });
  assert.equal(d.ok, false);
  assert.equal(d.httpStatus, 404);
  assert.equal(d.zoomCode, 7013);
});
