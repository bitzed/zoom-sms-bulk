import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS drafts (
  id         TEXT PRIMARY KEY,
  operator   TEXT,
  sender     TEXT,
  body       TEXT NOT NULL DEFAULT '',
  raw_input  TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,
  operator     TEXT NOT NULL,
  agreed_at    TEXT NOT NULL,
  sender       TEXT NOT NULL,
  template     TEXT NOT NULL,
  status       TEXT NOT NULL,
  pause_reason TEXT,
  resume_at    TEXT,
  concurrency  INTEGER NOT NULL DEFAULT 1,
  dry_run      INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  finished_at  TEXT
);

CREATE TABLE IF NOT EXISTS recipients (
  id              INTEGER PRIMARY KEY,
  job_id          TEXT NOT NULL REFERENCES jobs(id),
  seq             INTEGER NOT NULL,
  phone           TEXT NOT NULL,
  vars            TEXT,
  status          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  message_id      TEXT,
  session_id      TEXT,
  delivery_status TEXT,
  last_error      TEXT,
  UNIQUE (job_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_dispatch
  ON recipients (job_id, status, next_attempt_at, seq);

CREATE TABLE IF NOT EXISTS attempts (
  id           INTEGER PRIMARY KEY,
  recipient_id INTEGER NOT NULL REFERENCES recipients(id),
  attempt_no   INTEGER NOT NULL,
  started_at   TEXT NOT NULL,
  http_status  INTEGER,
  zoom_code    INTEGER,
  rl_type      TEXT,
  rl_remaining INTEGER,
  tracking_id  TEXT,
  error        TEXT,
  latency_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_attempts_recipient ON attempts (recipient_id);

CREATE TABLE IF NOT EXISTS dnc (
  phone      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  added_by   TEXT,
  created_at TEXT NOT NULL
);
`;

/** Time-sortable id, short enough to sit in a URL. */
export function newId() {
  return Date.now().toString(36) + crypto.randomBytes(6).toString('hex');
}

const nowIso = () => new Date().toISOString();

export function openStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const cache = new Map();
  const sql = (text) => {
    let stmt = cache.get(text);
    if (!stmt) {
      stmt = db.prepare(text);
      cache.set(text, stmt);
    }
    return stmt;
  };

  const hydrate = (row) =>
    row ? { ...row, vars: row.vars ? JSON.parse(row.vars) : {} } : null;

  const store = {
    db,

    // ---- drafts ----------------------------------------------------------
    saveDraft({ id, operator, sender, body, rawInput }) {
      const draftId = id ?? newId();
      sql(
        `INSERT INTO drafts (id, operator, sender, body, raw_input, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           operator = excluded.operator,
           sender = excluded.sender,
           body = excluded.body,
           raw_input = excluded.raw_input,
           updated_at = excluded.updated_at`
      ).run(draftId, operator ?? null, sender ?? null, body ?? '', rawInput ?? '', nowIso());
      return draftId;
    },
    getDraft(id) {
      return sql('SELECT * FROM drafts WHERE id = ?').get(id) ?? null;
    },
    latestDraft(operator) {
      return (
        sql('SELECT * FROM drafts WHERE operator = ? ORDER BY updated_at DESC LIMIT 1').get(
          operator
        ) ?? null
      );
    },

    // ---- jobs ------------------------------------------------------------
    createJob({ operator, agreedAt, sender, template, concurrency, dryRun, rows }) {
      const id = newId();
      db.exec('BEGIN IMMEDIATE');
      try {
        sql(
          `INSERT INTO jobs (id, operator, agreed_at, sender, template, status,
                             concurrency, dry_run, created_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`
        ).run(id, operator, agreedAt, sender, template, concurrency, dryRun ? 1 : 0, nowIso());

        const insert = sql(
          `INSERT INTO recipients (job_id, seq, phone, vars, status)
           VALUES (?, ?, ?, ?, 'pending')`
        );
        for (const row of rows) {
          insert.run(id, row.seq, row.phone, JSON.stringify(row.vars ?? {}));
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return id;
    },
    getJob(id) {
      return sql('SELECT * FROM jobs WHERE id = ?').get(id) ?? null;
    },
    listJobs(limit = 50) {
      return sql('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
    },
    setJobStatus(id, status, { pauseReason = null, resumeAt = null, finished = false } = {}) {
      sql(
        `UPDATE jobs SET status = ?, pause_reason = ?, resume_at = ?,
                         finished_at = CASE WHEN ? THEN ? ELSE finished_at END
         WHERE id = ?`
      ).run(status, pauseReason, resumeAt, finished ? 1 : 0, nowIso(), id);
    },

    // ---- recipients ------------------------------------------------------
    /**
     * Atomically takes the next due recipient in input order and marks it
     * in-flight. Ordering by seq is what makes "sequential" true even when
     * several workers are running.
     */
    claimNext(jobId, at = nowIso()) {
      return hydrate(
        sql(
          `UPDATE recipients
              SET status = 'sending', attempts = attempts + 1
            WHERE id = (
              SELECT id FROM recipients
               WHERE job_id = ?
                 AND (status = 'pending'
                      OR (status = 'retry_wait' AND next_attempt_at <= ?))
               ORDER BY seq
               LIMIT 1)
          RETURNING *`
        ).get(jobId, at) ?? null
      );
    },
    markAccepted(id, { messageId, sessionId }) {
      sql(
        `UPDATE recipients SET status = 'accepted', message_id = ?, session_id = ?,
                               last_error = NULL, next_attempt_at = NULL
         WHERE id = ?`
      ).run(messageId ?? null, sessionId ?? null, id);
    },
    /**
     * Hands a claimed recipient back untouched — used when the send never
     * happened (job cancelled, configuration error), so the attempt should not
     * count against it.
     */
    releaseClaim(id, error) {
      sql(
        `UPDATE recipients
            SET status = 'pending', attempts = MAX(0, attempts - 1),
                next_attempt_at = NULL, last_error = ?
          WHERE id = ?`
      ).run(error ?? null, id);
    },
    scheduleRetry(id, nextAttemptAtIso, error) {
      sql(
        `UPDATE recipients SET status = 'retry_wait', next_attempt_at = ?, last_error = ?
         WHERE id = ?`
      ).run(nextAttemptAtIso, error ?? null, id);
    },
    markTerminal(id, status, error) {
      sql(
        `UPDATE recipients SET status = ?, last_error = ?, next_attempt_at = NULL WHERE id = ?`
      ).run(status, error ?? null, id);
    },
    requeueFailed(jobId) {
      const res = sql(
        `UPDATE recipients SET status = 'pending', attempts = 0, next_attempt_at = NULL
         WHERE job_id = ? AND status IN ('failed', 'unknown')`
      ).run(jobId);
      return res.changes;
    },

    // ---- delivery status -------------------------------------------------
    // Filled in after the fact by polling Zoom's SMS message-detail endpoint.
    // A send returning 2xx only means "accepted"; this is the closest we get
    // to knowing whether it actually reached the carrier/handset.
    setDeliveryStatus(id, status) {
      sql('UPDATE recipients SET delivery_status = ? WHERE id = ?').run(status ?? null, id);
    },
    /**
     * Accepted recipients whose delivery status is not yet settled. Once Zoom
     * reports a terminal state (delivered / undelivered / failed / received)
     * there is nothing left to poll, so those are excluded — reopening the page
     * re-checks only what can still change. dry-run sends have no real ids.
     */
    recipientsNeedingDelivery(jobId) {
      return sql(
        `SELECT * FROM recipients
          WHERE job_id = ? AND status = 'accepted'
            AND message_id IS NOT NULL AND session_id IS NOT NULL
            AND session_id != 'dry-run'
            AND (delivery_status IS NULL
                 OR delivery_status NOT IN ('delivered','undelivered','failed','received'))
          ORDER BY seq`
      ).all(jobId).map(hydrate);
    },
    deliveryCounts(jobId) {
      const rows = sql(
        `SELECT delivery_status AS s, COUNT(*) AS c
           FROM recipients WHERE job_id = ? AND status = 'accepted'
          GROUP BY delivery_status`
      ).all(jobId);
      const out = { delivered: 0, undelivered: 0, other: 0, unchecked: 0, accepted: 0 };
      for (const { s, c } of rows) {
        out.accepted += c;
        if (s === 'delivered' || s === 'received') out.delivered += c;
        else if (s === 'undelivered' || s === 'failed') out.undelivered += c;
        else if (s == null) out.unchecked += c;
        else out.other += c;
      }
      return out;
    },

    counts(jobId) {
      const out = {
        pending: 0,
        sending: 0,
        retry_wait: 0,
        accepted: 0,
        failed: 0,
        skipped: 0,
        unknown: 0,
      };
      for (const row of sql(
        'SELECT status, COUNT(*) AS c FROM recipients WHERE job_id = ? GROUP BY status'
      ).all(jobId)) {
        out[row.status] = row.c;
      }
      out.total = Object.values(out).reduce((a, b) => a + b, 0);
      out.done = out.accepted + out.failed + out.skipped + out.unknown;
      return out;
    },
    listRecipients(jobId, { limit = 1000, offset = 0 } = {}) {
      return sql(
        'SELECT * FROM recipients WHERE job_id = ? ORDER BY seq LIMIT ? OFFSET ?'
      ).all(jobId, limit, offset).map(hydrate);
    },
    nextWakeAt(jobId) {
      const row = sql(
        `SELECT MIN(next_attempt_at) AS at FROM recipients
          WHERE job_id = ? AND status = 'retry_wait'`
      ).get(jobId);
      return row?.at ?? null;
    },
    inFlight(jobId) {
      return sql(
        `SELECT COUNT(*) AS c FROM recipients WHERE job_id = ? AND status = 'sending'`
      ).get(jobId).c;
    },

    // ---- attempts --------------------------------------------------------
    logAttempt(recipientId, attemptNo, result) {
      sql(
        `INSERT INTO attempts (recipient_id, attempt_no, started_at, http_status, zoom_code,
                               rl_type, rl_remaining, tracking_id, error, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        recipientId,
        attemptNo,
        result.startedAt,
        result.httpStatus ?? null,
        result.zoomCode ?? null,
        result.rate?.type ?? null,
        result.rate?.remaining ?? null,
        result.trackingId ?? null,
        result.error ?? null,
        result.latencyMs ?? null
      );
    },
    attemptsFor(recipientId) {
      return sql(
        'SELECT * FROM attempts WHERE recipient_id = ? ORDER BY attempt_no'
      ).all(recipientId);
    },

    // ---- do-not-contact --------------------------------------------------
    listDnc() {
      return sql('SELECT * FROM dnc ORDER BY created_at DESC').all();
    },
    dncSet() {
      return new Set(sql('SELECT phone FROM dnc').all().map((r) => r.phone));
    },
    addDnc(phone, reason, addedBy) {
      sql(
        `INSERT INTO dnc (phone, reason, added_by, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(phone) DO UPDATE SET reason = excluded.reason`
      ).run(phone, reason || 'manual', addedBy ?? null, nowIso());
    },
    removeDnc(phone) {
      sql('DELETE FROM dnc WHERE phone = ?').run(phone);
    },

    /**
     * Called once at boot. A row left in 'sending' means the process died after
     * the request went out: we cannot know whether Zoom received it, so it
     * becomes 'unknown' rather than being silently retried into a double send.
     */
    recoverFromCrash() {
      const orphaned = sql(
        `UPDATE recipients SET status = 'unknown',
                last_error = 'process restarted while this request was in flight'
          WHERE status = 'sending'`
      ).run();
      const jobs = sql(
        `UPDATE jobs SET status = 'paused', pause_reason = 'restarted'
          WHERE status IN ('running', 'queued')`
      ).run();
      return { recipients: orphaned.changes, jobs: jobs.changes };
    },

    close() {
      db.close();
    },
  };

  return store;
}
