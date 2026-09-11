import { parse as parseCsv } from 'csv-parse/sync';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

const PHONE_HEADERS = new Set([
  'phone',
  'phone_number',
  'phonenumber',
  'tel',
  'telephone',
  'number',
  'mobile',
  'msisdn',
  'to',
  '電話番号',
  '電話',
  '携帯',
  '携帯番号',
  '宛先',
]);

const isPhoneHeader = (cell) => PHONE_HEADERS.has(String(cell ?? '').trim().toLowerCase());

/**
 * Accepts three shapes without asking the user which one they have:
 *   1. CSV/TSV with a header row containing a phone-ish column
 *   2. CSV/TSV without a header (first column is the phone number)
 *   3. A plain newline-separated list of numbers
 */
function detectShape(text) {
  const lines = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (lines.length === 0) return { format: 'list', delimiter: ',', lines };

  const first = lines[0];
  const tabs = (first.match(/\t/g) ?? []).length;
  const commas = (first.match(/,/g) ?? []).length;
  if (tabs === 0 && commas === 0) return { format: 'list', delimiter: ',', lines };

  const delimiter = tabs > commas ? '\t' : ',';
  const header = first.split(delimiter).some(isPhoneHeader);
  return { format: header ? 'csv-header' : 'csv', delimiter, lines };
}

function toRecords(text) {
  const { format, delimiter, lines } = detectShape(text);
  if (format === 'list') {
    return {
      format,
      columns: [],
      records: lines.map((line, i) => ({ line: i + 1, raw: line.trim(), vars: {} })),
    };
  }

  const rows = parseCsv(lines.join('\n'), {
    delimiter,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
    trim: true,
  });

  let header = null;
  let phoneIndex = 0;
  let body = rows;
  if (format === 'csv-header') {
    header = rows[0].map((c) => String(c ?? '').trim());
    phoneIndex = header.findIndex(isPhoneHeader);
    body = rows.slice(1);
  }

  const columns = header
    ? header.filter((_, i) => i !== phoneIndex).filter(Boolean)
    : (rows[0]?.length ? Array.from({ length: rows[0].length - 1 }, (_, i) => `col${i + 2}`) : []);

  const records = body.map((cells, i) => {
    const vars = {};
    cells.forEach((cell, idx) => {
      if (idx === phoneIndex) return;
      const key = header ? header[idx] : `col${idx + 1}`;
      if (key) vars[key] = String(cell ?? '').trim();
    });
    return {
      line: i + 1 + (header ? 1 : 0),
      raw: String(cells[phoneIndex] ?? '').trim(),
      vars,
    };
  });

  return { format, columns, records };
}

/**
 * Normalises to E.164 and partitions the input. Nothing is silently dropped:
 * every rejected row is returned with the reason so the preview screen can
 * show it back to the operator.
 */
export function parseRecipients(text, { defaultRegion = 'JP', dnc = new Set() } = {}) {
  const clean = String(text ?? '')
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n');

  const { format, columns, records } = toRecords(clean);

  const rows = [];
  const invalid = [];
  const duplicates = [];
  const blocked = [];
  const seen = new Map();

  for (const rec of records) {
    if (!rec.raw) {
      invalid.push({ ...rec, reason: 'empty' });
      continue;
    }

    const parsed = parsePhoneNumberFromString(rec.raw, defaultRegion);
    if (!parsed || !parsed.isValid()) {
      invalid.push({ ...rec, reason: 'not_a_valid_number' });
      continue;
    }
    const phone = parsed.number; // E.164

    if (seen.has(phone)) {
      duplicates.push({ ...rec, phone, firstSeq: seen.get(phone) });
      continue;
    }
    if (dnc.has(phone)) {
      blocked.push({ ...rec, phone, reason: 'do_not_contact' });
      continue;
    }

    const seq = rows.length + 1;
    seen.set(phone, seq);
    rows.push({ seq, phone, raw: rec.raw, vars: rec.vars, country: parsed.country ?? null });
  }

  return { format, columns, rows, invalid, duplicates, blocked, total: records.length };
}

/** +818012345678 -> +8180****5244 */
export function maskPhone(phone) {
  if (!phone || phone.length < 8) return '***';
  return `${phone.slice(0, 5)}****${phone.slice(-4)}`;
}
