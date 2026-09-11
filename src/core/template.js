// GSM 03.38 basic alphabet. Anything outside it forces the whole message to UCS-2.
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
// Extension chars are encoded as an escape + the char, i.e. two septets each.
const GSM_EXT = '^{}\\[~]|€';

const BASIC = new Set(GSM_BASIC);
const EXT = new Set(GSM_EXT);

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Distinct placeholder names used in a template, in order of first appearance. */
export function placeholders(body) {
  const found = [];
  for (const [, name] of body.matchAll(PLACEHOLDER)) {
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/** Replaces {{name}} with vars.name. Unknown placeholders become an empty string. */
export function render(body, vars = {}) {
  return body.replace(PLACEHOLDER, (_, name) => {
    const value = vars[name];
    return value == null ? '' : String(value);
  });
}

/**
 * Character count and SMS segment count. Japanese text is UCS-2, so the usual
 * limit people are surprised by is 70 characters per segment, not 160.
 */
export function analyze(text) {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (BASIC.has(ch)) septets += 1;
    else if (EXT.has(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }

  // SMS length is measured in UTF-16 code units, so surrogate pairs count as 2.
  const units = gsm ? septets : text.length;
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  const segments = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);

  return {
    encoding: gsm ? 'GSM-7' : 'UCS-2',
    units,
    chars: [...text].length,
    perSegment: segments > 1 ? multi : single,
    segments,
  };
}
