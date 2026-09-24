import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import pino from 'pino';

import { loadConfig, ConfigError } from './config.js';
import { openStore } from './core/store.js';
import { createGovernor } from './core/governor.js';
import { createRunner } from './core/runner.js';
import { parseRecipients, maskPhone } from './core/parse.js';
import { createCredentialProvider } from './zoom/auth.js';
import { createSmsClient } from './zoom/sms.js';
import {
  gatePage,
  composePage,
  previewPage,
  jobPage,
  jobsPage,
  dncPage,
  errorPage,
  RECIPIENT_STATUS,
  deliveryView,
} from './ui/pages.js';

// ---------------------------------------------------------------- boot

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const logger = pino({ level: config.log.level });
const store = openStore(config.storage.dbPath);

const recovered = store.recoverFromCrash();
if (recovered.recipients || recovered.jobs) {
  logger.warn(recovered, 'recovered state left behind by a previous process');
}

const credentials = config.safety.dryRun
  ? { get: async () => 'dry-run', invalidate() {} }
  : createCredentialProvider({
      accountId: config.zoom.accountId,
      clientId: config.zoom.clientId,
      clientSecret: config.zoom.clientSecret,
      marginSec: config.zoom.tokenRefreshMarginSec,
      timeoutMs: config.zoom.requestTimeoutMs,
      logger,
    });

const sms = createSmsClient({
  credentials,
  timeoutMs: config.zoom.requestTimeoutMs,
  dryRun: config.safety.dryRun,
  logger,
});

const governor = createGovernor({
  ceiling: config.rate.ceiling,
  onChange: (change) => logger.info(change, 'send rate adjusted'),
});

const runner = createRunner({ store, sms, governor, config, logger });

// ------------------------------------------------------------- session

const COOKIE = 'zsb_session';

function signSession(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const mac = crypto
    .createHmac('sha256', config.gate.sessionSecret)
    .update(payload)
    .digest('base64url');
  return `${payload}.${mac}`;
}

function readSession(raw) {
  if (!raw) return null;
  const [payload, mac] = String(raw).split('.');
  if (!payload || !mac) return null;
  const expected = crypto
    .createHmac('sha256', config.gate.sessionSecret)
    .update(payload)
    .digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

const constantEquals = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// ---------------------------------------------------------------- app

const app = new Hono();
const ctx = { config };
const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');

app.get('/healthz', (c) =>
  c.json({
    ok: true,
    dryRun: config.safety.dryRun,
    storage: {
      mode: config.storage.mode,
      durabilityProven: config.storage.proven,
      bootCount: config.storage.bootCount,
    },
    rate: governor.stats(),
  })
);

app.get('/assets/:file', (c) => {
  const file = c.req.param('file');
  if (!/^[\w.-]+$/.test(file)) return c.notFound();
  const full = path.join(ASSETS, file);
  if (!full.startsWith(ASSETS) || !fs.existsSync(full)) return c.notFound();
  const type = file.endsWith('.css') ? 'text/css' : 'text/javascript';
  return c.body(fs.readFileSync(full), 200, { 'Content-Type': `${type}; charset=utf-8` });
});

app.use('*', async (c, next) => {
  const open = ['/', '/gate', '/healthz'];
  if (open.includes(c.req.path) || c.req.path.startsWith('/assets/')) return next();
  const session = readSession(getCookie(c, COOKIE));
  if (!session) return c.redirect('/', 303);
  c.set('session', session);
  return next();
});

// ---- ① gate ----------------------------------------------------------

app.get('/', (c) => {
  if (readSession(getCookie(c, COOKIE))) return c.redirect('/compose', 303);
  return c.html(gatePage(ctx));
});

app.post('/gate', async (c) => {
  const form = await c.req.parseBody();
  const operator = String(form.operator ?? '').trim();
  if (!form.agreed) {
    return c.html(gatePage(ctx, { error: '内容を確認のうえチェックを入れてください。', operator }));
  }
  if (!operator || !constantEquals(form.password ?? '', config.gate.password)) {
    logger.warn({ operator }, 'gate rejected');
    return c.html(
      gatePage(ctx, { error: '実行者名またはパスワードが正しくありません。', operator })
    );
  }
  const session = { operator, agreedAt: new Date().toISOString(), exp: Date.now() + config.gate.sessionTtlMs };
  setCookie(c, COOKIE, signSession(session), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: c.req.url.startsWith('https://'),
    path: '/',
    maxAge: Math.floor(config.gate.sessionTtlMs / 1000),
  });
  logger.info({ operator }, 'gate accepted');
  return c.redirect('/compose', 303);
});

app.post('/logout', (c) => {
  deleteCookie(c, COOKIE, { path: '/' });
  return c.redirect('/', 303);
});

// ---- ② compose -------------------------------------------------------

app.get('/compose', (c) => {
  const session = c.get('session');
  return c.html(composePage(ctx, { draft: store.latestDraft(session.operator) }));
});

app.post('/api/draft', async (c) => {
  const session = c.get('session');
  const { draftId, body, recipients } = await c.req.json();
  const id = store.saveDraft({
    id: draftId || undefined,
    operator: session.operator,
    sender: config.zoom.senderNumber,
    body,
    rawInput: recipients,
  });
  return c.json({ id });
});

// ---- ③ preview -------------------------------------------------------

function parseForJob(rawInput) {
  return parseRecipients(rawInput, {
    defaultRegion: config.safety.defaultRegion,
    dnc: store.dncSet(),
  });
}

function validate(parsed, body) {
  if (!body?.trim()) return '本文が空です。';
  if (parsed.rows.length === 0) return '送信できる宛先がありません。入力を確認してください。';
  if (parsed.rows.length > config.safety.maxRecipientsPerJob) {
    return `宛先が ${parsed.rows.length} 件あります。1 ジョブあたりの上限は ${config.safety.maxRecipientsPerJob} 件です。分割してください。`;
  }
  return null;
}

app.post('/preview', async (c) => {
  const session = c.get('session');
  const form = await c.req.parseBody();
  const body = String(form.body ?? '');
  const rawInput = String(form.recipients ?? '');
  const concurrency = Math.min(8, Math.max(1, Number(form.concurrency) || 1));

  const draftId = store.saveDraft({
    id: form.draftId || undefined,
    operator: session.operator,
    sender: config.zoom.senderNumber,
    body,
    rawInput,
  });

  const parsed = parseForJob(rawInput);
  return c.html(
    previewPage(ctx, {
      draft: { id: draftId, body },
      parsed,
      concurrency,
      blockingError: validate(parsed, body),
    })
  );
});

// ---- ④ send ----------------------------------------------------------

app.post('/send', async (c) => {
  const session = c.get('session');
  const form = await c.req.parseBody();
  if (!form.confirm) {
    return c.html(
      errorPage(ctx, { title: '確認が必要です', message: '確認チェックが入っていません。' })
    );
  }
  const draft = store.getDraft(String(form.draftId ?? ''));
  if (!draft) {
    return c.html(errorPage(ctx, { title: '下書きが見つかりません', message: '再度作成してください。' }));
  }

  // Re-parse from the stored draft rather than trusting anything the preview
  // page carried back: the DNC list or the limits may have changed since.
  const parsed = parseForJob(draft.raw_input);
  const blocking = validate(parsed, draft.body);
  if (blocking) {
    return c.html(errorPage(ctx, { title: '送信できません', message: blocking }));
  }

  const jobId = store.createJob({
    operator: session.operator,
    agreedAt: session.agreedAt,
    sender: config.zoom.senderNumber,
    template: draft.body,
    concurrency: Math.min(8, Math.max(1, Number(form.concurrency) || 1)),
    dryRun: config.safety.dryRun,
    rows: parsed.rows,
  });

  logger.info(
    { jobId, operator: session.operator, count: parsed.rows.length, dryRun: config.safety.dryRun },
    'job created'
  );
  runner.start(jobId).catch((err) => logger.error({ err, jobId }, 'runner failed'));
  return c.redirect(`/jobs/${jobId}`, 303);
});

// ---- ⑤ job views -----------------------------------------------------

app.get('/jobs', (c) => {
  const jobs = store.listJobs(50).map((j) => {
    const counts = store.counts(j.id);
    return { ...j, accepted: counts.accepted, total: counts.total };
  });
  return c.html(jobsPage(ctx, { jobs }));
});

app.get('/jobs/:id', (c) => {
  const job = store.getJob(c.req.param('id'));
  if (!job) return c.html(errorPage(ctx, { title: '見つかりません', message: 'そのジョブはありません。' }), 404);
  return c.html(
    jobPage(ctx, {
      job,
      counts: store.counts(job.id),
      recipients: store.listRecipients(job.id, { limit: 500 }),
    })
  );
});

app.get('/jobs/:id/stream', (c) => {
  const id = c.req.param('id');
  return streamSSE(c, async (stream) => {
    const queue = [runner.snapshot(id)];
    const onUpdate = (snap) => {
      if (snap.jobId === id) queue.push(snap);
    };
    runner.events.on('update', onUpdate);

    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
    });

    try {
      let ticks = 0;
      while (!aborted) {
        while (queue.length) {
          const snap = queue.shift();
          await stream.writeSSE({ data: JSON.stringify(snap) });
          if (['done', 'canceled'].includes(snap.status)) return;
        }
        if (++ticks % 60 === 0) await stream.writeSSE({ event: 'ping', data: '' });
        await stream.sleep(250);
      }
    } finally {
      runner.events.off('update', onUpdate);
    }
  });
});

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

app.get('/jobs/:id/export.csv', (c) => {
  const job = store.getJob(c.req.param('id'));
  if (!job) return c.notFound();
  const header = ['seq', 'phone', 'status', 'status_label', 'delivery_status', 'attempts', 'message_id', 'session_id', 'last_error'];
  const lines = [header.join(',')];
  for (const r of store.listRecipients(job.id, { limit: 1_000_000 })) {
    lines.push(
      [
        r.seq,
        r.phone,
        r.status,
        RECIPIENT_STATUS[r.status]?.label ?? r.status,
        r.delivery_status ?? '',
        r.attempts,
        r.message_id,
        r.session_id,
        r.last_error,
      ]
        .map(csvCell)
        .join(',')
    );
  }
  // BOM so Excel on Windows opens the Japanese labels correctly.
  return c.body(`﻿${lines.join('\n')}\n`, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="sms-${job.id}.csv"`,
  });
});

for (const [action, handler] of [
  ['pause', (id) => runner.pause(id)],
  ['cancel', (id) => runner.cancel(id)],
  [
    'resume',
    (id) => runner.start(id).catch((err) => logger.error({ err, id }, 'resume failed')),
  ],
]) {
  app.post(`/jobs/:id/${action}`, (c) => {
    const id = c.req.param('id');
    if (!store.getJob(id)) return c.notFound();
    handler(id);
    return c.redirect(`/jobs/${id}`, 303);
  });
}

app.post('/jobs/:id/retry', (c) => {
  const id = c.req.param('id');
  if (!store.getJob(id)) return c.notFound();
  const n = store.requeueFailed(id);
  logger.info({ jobId: id, requeued: n }, 'requeued failed recipients');
  runner.start(id).catch((err) => logger.error({ err, id }, 'retry failed'));
  return c.redirect(`/jobs/${id}`, 303);
});

// Polls Zoom for the delivery status of every accepted-but-unsettled message
// in this job, updates the store, and returns the current picture for the whole
// job so the page can repaint. A read-only operation: worst case a check fails
// and the recipient stays "unchecked", which is harmless.
const DELIVERY_POLL_CONCURRENCY = 4;

app.post('/jobs/:id/delivery', async (c) => {
  const id = c.req.param('id');
  if (!store.getJob(id)) return c.notFound();

  const targets = store.recipientsNeedingDelivery(id);
  let updated = 0;
  for (let i = 0; i < targets.length; i += DELIVERY_POLL_CONCURRENCY) {
    const batch = targets.slice(i, i + DELIVERY_POLL_CONCURRENCY);
    await Promise.all(
      batch.map(async (r) => {
        const d = await sms.fetchDelivery({ sessionId: r.session_id, messageId: r.message_id });
        if (d.ok && d.deliveryStatus) {
          store.setDeliveryStatus(r.id, d.deliveryStatus);
          updated += 1;
        }
      })
    );
  }

  // Return the full accepted set so the client can repaint every row, not just
  // the ones that changed this time.
  const recipients = store
    .listRecipients(id, { limit: 1_000_000 })
    .filter((r) => r.status === 'accepted' && r.session_id && r.session_id !== 'dry-run')
    .map((r) => ({ seq: r.seq, ...deliveryView(r.delivery_status) }));

  logger.info({ jobId: id, checked: targets.length, updated }, 'polled delivery status');
  return c.json({ checked: targets.length, updated, counts: store.deliveryCounts(id), recipients });
});

// ---- do-not-contact --------------------------------------------------

app.get('/dnc', (c) => c.html(dncPage(ctx, { entries: store.listDnc() })));

app.post('/dnc', async (c) => {
  const session = c.get('session');
  const form = await c.req.parseBody();
  const parsed = parseRecipients(String(form.phone ?? ''), {
    defaultRegion: config.safety.defaultRegion,
  });
  if (parsed.rows.length !== 1) {
    return c.html(
      errorPage(ctx, { title: '番号が不正です', message: '有効な電話番号を 1 件入力してください。', backTo: '/dnc' })
    );
  }
  store.addDnc(parsed.rows[0].phone, String(form.reason ?? ''), session.operator);
  logger.info({ phone: maskPhone(parsed.rows[0].phone), by: session.operator }, 'dnc added');
  return c.redirect('/dnc', 303);
});

app.post('/dnc/delete', async (c) => {
  const form = await c.req.parseBody();
  store.removeDnc(String(form.phone ?? ''));
  return c.redirect('/dnc', 303);
});

// ---------------------------------------------------------------- serve

serve({ fetch: app.fetch, port: config.server.port }, (info) => {
  logger.info(
    {
      port: info.port,
      dryRun: config.safety.dryRun,
      dataDir: config.storage.dataDir,
      storage: config.storage.mode,
      durabilityProven: config.storage.proven,
      rateCeiling: config.rate.ceiling,
      concurrency: config.rate.concurrency,
      plan: config.rate.plan,
    },
    'zoom-sms-bulk listening'
  );
  if (config.safety.dryRun) {
    logger.warn('DRY_RUN is on — no SMS will be sent');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info('shutting down');
    store.close();
    process.exit(0);
  });
}
