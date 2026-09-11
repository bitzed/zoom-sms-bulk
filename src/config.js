import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';

// Node 22 can read .env natively. Missing file is fine.
try {
  process.loadEnvFile();
} catch {
  /* no .env present */
}

const bool = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v)));

const int = (def, min, max) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .refine((v) => Number.isFinite(v) && v >= min && v <= max, {
      message: `must be a number between ${min} and ${max}`,
    });

const EnvSchema = z.object({
  ZOOM_ACCOUNT_ID: z.string().optional(),
  ZOOM_CLIENT_ID: z.string().optional(),
  ZOOM_CLIENT_SECRET: z.string().optional(),
  SENDER_NUMBER: z.string().optional(),

  ACCESS_PASSWORD: z.string().min(1, 'ACCESS_PASSWORD is required'),
  SESSION_SECRET: z.string().optional(),

  DATA_DIR: z.string().optional().default('./data'),
  STORAGE_MODE: z.enum(['durable', 'ephemeral']).optional(),

  ZOOM_PLAN: z.enum(['pro', 'business']).optional().default('pro'),
  SEND_RATE_PER_SEC: z.string().optional(),
  CONCURRENCY: int(1, 1, 8),

  MAX_ATTEMPTS: int(5, 1, 10),
  BACKOFF_BASE_MS: int(1000, 100, 60_000),
  BACKOFF_MAX_MS: int(60_000, 1000, 600_000),
  CIRCUIT_THRESHOLD: int(10, 1, 1000),
  REQUEST_TIMEOUT_MS: int(15_000, 1000, 120_000),
  TOKEN_REFRESH_MARGIN_SEC: int(300, 30, 1800),

  MAX_RECIPIENTS_PER_JOB: int(200, 1, 100_000),
  QUIET_HOURS: z.string().optional().default('21-8'),
  DRY_RUN: bool(false),

  // Posted a job summary so results reach the operator even with the browser closed.
  NOTIFY_WEBHOOK_URL: z
    .string()
    .optional()
    .transform((v) => v?.trim() || null),
  // Used to build absolute job links in notifications.
  PUBLIC_URL: z
    .string()
    .optional()
    .transform((v) => v?.trim().replace(/\/+$/, '') || null),

  PORT: int(8080, 1, 65_535),
  LOG_LEVEL: z.string().optional().default('info'),
  MASK_PHONE: bool(true),
  DEFAULT_REGION: z.string().optional().default('JP'),
});

/** Nominal QPS of the Medium rate-limit tier, by plan. */
const NOMINAL_QPS = { pro: 10, business: 20 };

/**
 * "21-8" -> { start: 21, end: 8 }. Empty string disables quiet hours.
 * Ranges may wrap past midnight, which is the normal case.
 */
function parseQuietHours(raw) {
  if (!raw || !raw.trim()) return null;
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(raw.trim());
  if (!m) throw new Error(`QUIET_HOURS must look like "21-8", got "${raw}"`);
  const [start, end] = [Number(m[1]), Number(m[2])];
  if (start > 23 || end > 23) throw new Error(`QUIET_HOURS hours must be 0-23, got "${raw}"`);
  return start === end ? null : { start, end };
}

/**
 * Platforms whose filesystem is wiped on every restart. Running the app there
 * without acknowledgement means the operator loses drafts and history with no
 * warning, which is the single worst failure mode for a tool shared internally.
 */
const inContainer = () => {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
};

/**
 * Finds the mount point that `dir` actually lives on, given the contents of
 * /proc/self/mountinfo. Field 5 of each line is the mount point.
 *
 * Exported so the container detection below can be tested without a container.
 */
export function resolveMountPoint(mountinfo, dir) {
  const target = path.resolve(dir);
  let best = null;
  for (const line of String(mountinfo).split('\n')) {
    const point = line.split(' ')[4];
    if (!point || !point.startsWith('/')) continue;
    const covers = point === target || target.startsWith(point === '/' ? '/' : `${point}/`);
    if (covers && (best === null || point.length > best.length)) best = point;
  }
  return best;
}

/**
 * True when `dir` lives on a real mount rather than the container's own
 * writable layer — i.e. `docker run -v ...` was actually used. If the deepest
 * mount covering it is `/`, it is the overlay and it dies with the container.
 */
function isOnMount(dir) {
  let mountinfo;
  try {
    mountinfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return false; // no procfs (macOS): caller only asks inside containers
  }
  const point = resolveMountPoint(mountinfo, dir);
  return point !== null && point !== '/';
}

function detectEphemeralPlatform(dataDir) {
  if (process.env.DYNO) return 'Heroku (dyno filesystem is wiped on every restart)';
  if (process.env.K_SERVICE) return 'Cloud Run (container filesystem is not persisted)';
  const tmp = path.resolve(os.tmpdir());
  if (path.resolve(dataDir).startsWith(tmp + path.sep)) return `a temp directory (${tmp})`;
  // `docker run` without -v looks perfectly normal from inside, right up until
  // the container is replaced and every draft goes with it.
  if (inContainer() && !isOnMount(dataDir)) {
    return 'a container with no volume mounted (add: -v "$PWD/data:/data")';
  }
  return null;
}

/**
 * Reads/writes a boot marker so the UI can state, as a fact rather than a hope,
 * whether this data directory survived a previous restart.
 */
function inspectStorage(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const markerPath = path.join(dataDir, '.instance');
  let marker = null;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch {
    /* first boot, or the directory was wiped */
  }
  const next = marker
    ? { ...marker, bootCount: (marker.bootCount ?? 1) + 1, lastBootAt: new Date().toISOString() }
    : {
        id: crypto.randomUUID(),
        firstBootAt: new Date().toISOString(),
        lastBootAt: new Date().toISOString(),
        bootCount: 1,
      };
  fs.writeFileSync(markerPath, JSON.stringify(next, null, 2));
  return {
    bootCount: next.bootCount,
    firstBootAt: next.firstBootAt,
    // Surviving a restart is the only direct evidence of durability we can get.
    proven: next.bootCount > 1,
  };
}

class ConfigError extends Error {}

export function loadConfig() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const env = parsed.data;

  if (env.BACKOFF_MAX_MS < env.BACKOFF_BASE_MS) {
    throw new ConfigError('BACKOFF_MAX_MS must be >= BACKOFF_BASE_MS');
  }

  if (!env.DRY_RUN) {
    const missing = [
      'ZOOM_ACCOUNT_ID',
      'ZOOM_CLIENT_ID',
      'ZOOM_CLIENT_SECRET',
      'SENDER_NUMBER',
    ].filter((k) => !env[k]);
    if (missing.length) {
      throw new ConfigError(
        `Missing Zoom credentials: ${missing.join(', ')}\n` +
          '  Set them, or start with DRY_RUN=true to explore the UI without sending anything.'
      );
    }
  }

  const dataDir = path.resolve(env.DATA_DIR);
  const ephemeralPlatform = detectEphemeralPlatform(dataDir);
  if (ephemeralPlatform && env.STORAGE_MODE !== 'ephemeral') {
    throw new ConfigError(
      `Refusing to start: ${dataDir} is not persistent.\n` +
        `  Detected ${ephemeralPlatform}.\n` +
        '  Drafts, recipients and send history would be lost on every restart, and the\n' +
        '  people using this tool would have no way to tell that from a bug.\n\n' +
        '  Fix it by one of:\n' +
        `    A) Mount a persistent volume at ${dataDir}  (recommended)\n` +
        '    B) Deploy somewhere with a volume: Railway / Render / Fly.io\n' +
        '    C) Accept the data loss explicitly: STORAGE_MODE=ephemeral'
    );
  }

  const storage = inspectStorage(dataDir);
  const nominalQps = NOMINAL_QPS[env.ZOOM_PLAN];
  const ceiling = env.SEND_RATE_PER_SEC
    ? Number(env.SEND_RATE_PER_SEC)
    : Math.max(1, nominalQps * 0.8);
  if (!Number.isFinite(ceiling) || ceiling <= 0) {
    throw new ConfigError('SEND_RATE_PER_SEC must be a positive number');
  }

  return {
    zoom: {
      accountId: env.ZOOM_ACCOUNT_ID,
      clientId: env.ZOOM_CLIENT_ID,
      clientSecret: env.ZOOM_CLIENT_SECRET,
      senderNumber: env.SENDER_NUMBER ?? '(dry-run)',
      tokenRefreshMarginSec: env.TOKEN_REFRESH_MARGIN_SEC,
      requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    },
    gate: {
      password: env.ACCESS_PASSWORD,
      // Derive a stable secret from the password so a single env var is enough.
      sessionSecret:
        env.SESSION_SECRET ??
        crypto.createHash('sha256').update(`session:${env.ACCESS_PASSWORD}`).digest('hex'),
      sessionTtlMs: 8 * 60 * 60 * 1000,
    },
    storage: {
      dataDir,
      dbPath: path.join(dataDir, 'sms.db'),
      mode: env.STORAGE_MODE ?? 'durable',
      ephemeralPlatform,
      ...storage,
    },
    rate: {
      plan: env.ZOOM_PLAN,
      nominalQps,
      ceiling,
      concurrency: env.CONCURRENCY,
    },
    retry: {
      maxAttempts: env.MAX_ATTEMPTS,
      baseMs: env.BACKOFF_BASE_MS,
      maxMs: env.BACKOFF_MAX_MS,
      circuitThreshold: env.CIRCUIT_THRESHOLD,
    },
    safety: {
      maxRecipientsPerJob: env.MAX_RECIPIENTS_PER_JOB,
      quietHours: parseQuietHours(env.QUIET_HOURS),
      dryRun: env.DRY_RUN,
      defaultRegion: env.DEFAULT_REGION,
    },
    notify: { webhookUrl: env.NOTIFY_WEBHOOK_URL, publicUrl: env.PUBLIC_URL },
    server: { port: env.PORT },
    log: { level: env.LOG_LEVEL, maskPhone: env.MASK_PHONE },
  };
}

export { ConfigError };
