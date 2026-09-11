import { EventEmitter } from 'node:events';
import { nextAttemptAt } from './backoff.js';
import { render } from './template.js';
import { maskPhone } from './parse.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const JST_HOUR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Tokyo',
  hour: 'numeric',
  hourCycle: 'h23',
});

export function createRunner({ store, sms, governor, config, logger }) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const active = new Map(); // jobId -> { ctl, handle }

  const quiet = config.safety.quietHours;
  function inQuietHours(at = new Date()) {
    if (!quiet) return false;
    const hour = Number(JST_HOUR.format(at));
    // A range like 21-8 wraps past midnight, which is the usual case.
    return quiet.start < quiet.end
      ? hour >= quiet.start && hour < quiet.end
      : hour >= quiet.start || hour < quiet.end;
  }

  function snapshot(jobId, last = null) {
    const job = store.getJob(jobId);
    return {
      jobId,
      status: job?.status ?? 'unknown',
      pauseReason: job?.pause_reason ?? null,
      resumeAt: job?.resume_at ?? null,
      counts: store.counts(jobId),
      governor: governor.stats(),
      quietHours: inQuietHours(),
      last,
    };
  }

  const emit = (jobId, last) => events.emit('update', snapshot(jobId, last));

  function pause(jobId, reason, resumeAt = null) {
    store.setJobStatus(jobId, 'paused', { pauseReason: reason, resumeAt });
    logger?.warn({ jobId, reason, resumeAt }, 'job paused');
    emit(jobId);
  }

  async function dispatch(job, recipient, ctl) {
    await governor.acquire();
    if (ctl.stopped) {
      // Put it back rather than sending after a cancel.
      store.releaseClaim(recipient.id, null);
      return;
    }

    const message = render(job.template, recipient.vars);
    const res = await sms.send({ sender: job.sender, phone: recipient.phone, message });

    store.logAttempt(recipient.id, recipient.attempts, res);
    governor.observe(res.rate);

    const { maxAttempts, baseMs, maxMs, circuitThreshold } = config.retry;
    let outcome = res.kind;

    if (res.kind === 'ok') {
      store.markAccepted(recipient.id, { messageId: res.messageId, sessionId: res.sessionId });
      governor.success();
      ctl.consecutiveFailures = 0;
    } else if (res.kind === 'config') {
      // Credentials, scope or plan. Retrying would fail identically for every
      // remaining recipient, so hand this one back and stop the job.
      store.releaseClaim(recipient.id, res.error);
      emit(job.id, { seq: recipient.seq, phone: maskPhone(recipient.phone), outcome: 'config', error: res.error });
      pause(job.id, 'config_error');
      return;
    } else if (res.kind === 'ambiguous') {
      // Possibly delivered: the request may have reached Zoom before the
      // timeout. Never retried automatically — that would be a double send.
      store.markTerminal(recipient.id, 'unknown', res.error);
      ctl.consecutiveFailures += 1;
    } else if (res.kind === 'retryable') {
      if (res.httpStatus === 429) {
        governor.throttled();
        // The SMS endpoint only has a per-second limit, but if a daily bucket
        // ever shows up, hours of exponential backoff would just burn attempts.
        if (/daily/i.test(res.rate?.type ?? '') && res.rate?.retryAfter) {
          const at = res.rate.retryAfter.toISOString();
          store.scheduleRetry(recipient.id, at, res.error);
          pause(job.id, 'daily_limit', at);
          return;
        }
      }
      if (recipient.attempts >= maxAttempts) {
        store.markTerminal(
          recipient.id,
          'failed',
          `${res.error} (gave up after ${recipient.attempts} attempts)`
        );
        ctl.consecutiveFailures += 1;
        outcome = 'failed';
      } else {
        const at = nextAttemptAt({
          attempt: recipient.attempts - 1,
          retryAfter: res.rate?.retryAfter ?? null,
          baseMs,
          maxMs,
        });
        store.scheduleRetry(recipient.id, at.toISOString(), res.error);
      }
    } else {
      store.markTerminal(recipient.id, 'failed', res.error);
      ctl.consecutiveFailures += 1;
      outcome = 'failed';
      // 403 means scope, plan or sender-number permission — every remaining
      // recipient will fail the same way, so stop instead of burning the list.
      if (res.httpStatus === 403) {
        emit(job.id, { seq: recipient.seq, phone: maskPhone(recipient.phone), outcome });
        pause(job.id, 'config_error');
        return;
      }
    }

    emit(job.id, {
      seq: recipient.seq,
      phone: maskPhone(recipient.phone),
      outcome,
      attempts: recipient.attempts,
      httpStatus: res.httpStatus,
      error: res.error ?? null,
      latencyMs: res.latencyMs,
    });

    if (ctl.consecutiveFailures >= circuitThreshold) {
      pause(job.id, 'circuit');
    }
  }

  async function worker(jobId, ctl) {
    for (;;) {
      if (ctl.stopped) return;
      const job = store.getJob(jobId);
      if (!job || job.status !== 'running') return;

      if (inQuietHours()) {
        emit(jobId);
        await sleep(30_000);
        continue;
      }

      const recipient = store.claimNext(jobId);
      if (recipient) {
        await dispatch(job, recipient, ctl);
        continue;
      }

      // Nothing claimable right now: either waiting on a backoff timer, or on
      // another worker's in-flight request, or genuinely finished.
      const wake = store.nextWakeAt(jobId);
      if (wake) {
        await sleep(Math.max(50, Math.min(new Date(wake).getTime() - Date.now(), 1000)));
        continue;
      }
      if (store.inFlight(jobId) > 0) {
        await sleep(150);
        continue;
      }
      return;
    }
  }

  /**
   * The browser only sees the result while the tab is open. A webhook is the
   * one channel that still reaches the operator after they close it.
   */
  async function notifyWebhook(jobId) {
    const url = config.notify?.webhookUrl;
    if (!url) return;
    const job = store.getJob(jobId);
    const c = store.counts(jobId);
    const link = config.notify.publicUrl ? `${config.notify.publicUrl}/jobs/${jobId}` : null;
    const label = { done: '完了', canceled: '中断', paused: '一時停止' }[job.status] ?? job.status;
    const text =
      `SMS 一括送信 ${label}（実行者: ${job.operator}）\n` +
      `Zoom 受理 ${c.accepted} / 失敗 ${c.failed} / 不明 ${c.unknown} / ` +
      `未送信 ${c.pending + c.retry_wait}（全 ${c.total} 件）` +
      (job.pause_reason ? `\n理由: ${job.pause_reason}` : '') +
      (link ? `\n${link}` : '');

    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // `text` keeps it drop-in compatible with Slack incoming webhooks;
        // the structured fields are there for anything else.
        body: JSON.stringify({
          text,
          jobId,
          operator: job.operator,
          status: job.status,
          pauseReason: job.pause_reason,
          counts: c,
          url: link,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger?.warn({ err, jobId }, 'notification webhook failed');
    }
  }

  function finalize(jobId) {
    const job = store.getJob(jobId);
    if (!job) return;
    if (job.status === 'running') {
      const c = store.counts(jobId);
      const settled = c.pending === 0 && c.retry_wait === 0 && c.sending === 0;
      store.setJobStatus(jobId, settled ? 'done' : 'paused', {
        pauseReason: settled ? null : 'stopped',
        finished: settled,
      });
    }
    logger?.info({ jobId, counts: store.counts(jobId) }, 'job finished');
    emit(jobId);
    notifyWebhook(jobId).catch(() => {});
  }

  function start(jobId) {
    const existing = active.get(jobId);
    if (existing) return existing.handle;

    const job = store.getJob(jobId);
    if (!job) throw new Error(`no such job: ${jobId}`);

    const ctl = { stopped: false, consecutiveFailures: 0 };
    store.setJobStatus(jobId, 'running');
    emit(jobId);

    const workers = Array.from({ length: Math.max(1, job.concurrency) }, () =>
      worker(jobId, ctl)
    );
    const handle = Promise.all(workers)
      .catch((err) => {
        logger?.error({ err, jobId }, 'runner crashed');
        pause(jobId, 'error');
      })
      .then(() => finalize(jobId))
      .finally(() => active.delete(jobId));

    active.set(jobId, { ctl, handle });
    return handle;
  }

  return {
    events,
    start,
    isActive: (jobId) => active.has(jobId),
    snapshot,
    pause: (jobId) => pause(jobId, 'manual'),
    resume: (jobId) => start(jobId),
    cancel(jobId) {
      const entry = active.get(jobId);
      if (entry) entry.ctl.stopped = true;
      store.setJobStatus(jobId, 'canceled', { finished: true });
      emit(jobId);
    },
  };
}
