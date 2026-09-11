import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, ConfigError } from '../src/config.js';

const VALID = {
  ACCESS_PASSWORD: 'hunter2hunter2',
  ZOOM_ACCOUNT_ID: 'acct',
  ZOOM_CLIENT_ID: 'client',
  ZOOM_CLIENT_SECRET: 'secret',
  SENDER_NUMBER: '+818012345678',
};

// Scratch space must live outside os.tmpdir(), because "DATA_DIR is under the
// temp directory" is itself one of the conditions loadConfig() rejects.
const SCRATCH = path.join(process.cwd(), '.test-tmp');
function scratchDir(prefix) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  return fs.mkdtempSync(path.join(SCRATCH, prefix));
}

/**
 * loadConfig() reads process.env directly and writes a boot marker, so each
 * case runs against a pristine environment and its own throwaway directory.
 */
function withEnv(overrides, fn) {
  const saved = process.env;
  const dir = scratchDir('cfg-');
  // A bare object, so nothing from the developer's real .env leaks in.
  process.env = { PATH: saved.PATH, DATA_DIR: dir, ...overrides };
  try {
    return fn(dir);
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const expectRefusal = (overrides, pattern) =>
  withEnv(overrides, () => {
    assert.throws(() => loadConfig(), (err) => {
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err}`);
      assert.match(err.message, pattern);
      return true;
    });
  });

test('refuses to start without ACCESS_PASSWORD', () => {
  const { ACCESS_PASSWORD, ...rest } = VALID;
  expectRefusal(rest, /ACCESS_PASSWORD/);
});

test('refuses to start without Zoom credentials', () => {
  expectRefusal({ ACCESS_PASSWORD: 'pw' }, /Missing Zoom credentials/);
});

test('DRY_RUN lets the UI boot without Zoom credentials', () => {
  withEnv({ ACCESS_PASSWORD: 'pw', DRY_RUN: 'true' }, () => {
    const c = loadConfig();
    assert.equal(c.safety.dryRun, true);
    assert.equal(c.zoom.senderNumber, '(dry-run)');
  });
});

test('refuses to start on a platform with an ephemeral filesystem', () => {
  expectRefusal({ ...VALID, DYNO: 'web.1' }, /Heroku.*wiped|not persistent/s);
});

test('an explicit STORAGE_MODE=ephemeral is honoured', () => {
  withEnv({ ...VALID, DYNO: 'web.1', STORAGE_MODE: 'ephemeral' }, () => {
    const c = loadConfig();
    assert.equal(c.storage.mode, 'ephemeral');
    assert.match(c.storage.ephemeralPlatform, /Heroku/);
  });
});

test('refuses a DATA_DIR inside the temp directory', () => {
  // The "I'll just point it at /tmp" mistake this guard exists to catch.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsb-ephemeral-'));
  try {
    expectRefusal({ ...VALID, DATA_DIR: dir }, /temp directory/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the boot marker proves durability only after surviving a restart', () => {
  const dir = scratchDir('boot-');
  const persistent = path.join(dir, 'data'); // not directly under tmpdir root
  try {
    const first = withEnv({ ...VALID, DATA_DIR: persistent }, () => loadConfig());
    assert.equal(first.storage.bootCount, 1);
    assert.equal(first.storage.proven, false);

    const second = withEnv({ ...VALID, DATA_DIR: persistent }, () => loadConfig());
    assert.equal(second.storage.bootCount, 2);
    assert.equal(second.storage.proven, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the send rate ceiling is 80% of the plan nominal', () => {
  const dir = scratchDir('rate-');
  const data = path.join(dir, 'data');
  try {
    const pro = withEnv({ ...VALID, DATA_DIR: data, ZOOM_PLAN: 'pro' }, () => loadConfig());
    assert.equal(pro.rate.nominalQps, 10);
    assert.equal(pro.rate.ceiling, 8);

    const biz = withEnv({ ...VALID, DATA_DIR: data, ZOOM_PLAN: 'business' }, () => loadConfig());
    assert.equal(biz.rate.nominalQps, 20);
    assert.equal(biz.rate.ceiling, 16);

    const manual = withEnv(
      { ...VALID, DATA_DIR: data, ZOOM_PLAN: 'pro', SEND_RATE_PER_SEC: '3' },
      () => loadConfig()
    );
    assert.equal(manual.rate.ceiling, 3, 'an explicit value overrides the plan default');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('QUIET_HOURS parses a range that wraps past midnight', () => {
  const dir = scratchDir('qh-');
  const data = path.join(dir, 'data');
  try {
    const wrapped = withEnv({ ...VALID, DATA_DIR: data, QUIET_HOURS: '21-8' }, () => loadConfig());
    assert.deepEqual(wrapped.safety.quietHours, { start: 21, end: 8 });

    const off = withEnv({ ...VALID, DATA_DIR: data, QUIET_HOURS: '' }, () => loadConfig());
    assert.equal(off.safety.quietHours, null);

    assert.throws(
      () => withEnv({ ...VALID, DATA_DIR: data, QUIET_HOURS: 'evening' }, () => loadConfig()),
      /QUIET_HOURS/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the session secret is derived from the password when unset', () => {
  const dir = scratchDir('sess-');
  const data = path.join(dir, 'data');
  try {
    const a = withEnv({ ...VALID, DATA_DIR: data }, () => loadConfig());
    const b = withEnv({ ...VALID, DATA_DIR: data }, () => loadConfig());
    assert.equal(a.gate.sessionSecret, b.gate.sessionSecret, 'stable across restarts');
    assert.notEqual(a.gate.sessionSecret, VALID.ACCESS_PASSWORD, 'not the password itself');

    const c = withEnv({ ...VALID, DATA_DIR: data, ACCESS_PASSWORD: 'different' }, () =>
      loadConfig()
    );
    assert.notEqual(a.gate.sessionSecret, c.gate.sessionSecret, 'changing the password logs everyone out');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
