#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// node:sqlite is still flagged experimental in Node 22, and the warning it
// prints on import looks alarming to someone who just ran `npx`. Suppress that
// one line only — every other warning still comes through.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, type, ...rest) => {
  const name = typeof type === 'string' ? type : type?.type;
  if (name === 'ExperimentalWarning' && /SQLite/i.test(String(warning))) return;
  return emitWarning.call(process, warning, type, ...rest);
};

const pkg = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
    'utf8'
  )
);

const [command = 'serve', ...rest] = process.argv.slice(2);

const HELP = `zoom-sms-bulk ${pkg.version}
Bulk SMS sender for Zoom Phone — one sender number, many recipients.

USAGE
  zoom-sms-bulk [serve]        Start the web UI (default)
  zoom-sms-bulk --help
  zoom-sms-bulk --version

CONFIGURATION
  Read from the environment, or from a .env file in the working directory.
  Required: ACCESS_PASSWORD, plus Zoom credentials unless DRY_RUN=true.

  ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET   Server-to-Server OAuth
  SENDER_NUMBER            Sender phone number in E.164
  ACCESS_PASSWORD          Shared password for the web UI (required)
  DATA_DIR                 SQLite location, default ./data — mount a volume here
  PORT                     default 8080
  DRY_RUN=true             Explore the UI without calling the Zoom API

  See env.example for the full list.

QUICK START
  cp env.example .env && DRY_RUN=true zoom-sms-bulk
`;

if (command === '--help' || command === '-h' || command === 'help') {
  process.stdout.write(HELP);
  process.exit(0);
}
if (command === '--version' || command === '-v') {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}
if (command !== 'serve' || rest.length > 0) {
  process.stderr.write(`Unknown command: ${[command, ...rest].join(' ')}\n\n${HELP}`);
  process.exit(1);
}

await import('./server.js');
