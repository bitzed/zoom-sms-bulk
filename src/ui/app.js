// No build step, no framework. Two screens need behaviour: compose and job.

const GSM =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€';
const BASIC = new Set(GSM);
const EXT = new Set(GSM_EXT);

function analyze(text) {
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
  const units = gsm ? septets : text.length;
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  const segments = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);
  return { encoding: gsm ? 'GSM-7' : 'UCS-2', units, segments, perSegment: segments > 1 ? multi : single };
}

// Mirrors PHONE_HEADERS in src/core/parse.js. Kept in sync by hand because the
// alternative — shipping the parser to the browser — is a build step.
const PHONE_HEADERS = new Set([
  'phone', 'phone_number', 'phonenumber', 'tel', 'telephone', 'number',
  'mobile', 'msisdn', 'to', '電話番号', '電話', '携帯', '携帯番号', '宛先',
]);

/**
 * Which variable names the recipient list can supply.
 *   []    — a plain list of numbers, so no variables at all
 *   [...] — the CSV's non-phone column names (or col2, col3… when headerless)
 */
function detectColumns(text) {
  const lines = text.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  if (!lines.length) return [];

  const first = lines[0];
  const tabs = (first.match(/\t/g) ?? []).length;
  const commas = (first.match(/,/g) ?? []).length;
  if (!tabs && !commas) return [];

  const cells = first
    .split(tabs > commas ? '\t' : ',')
    .map((c) => c.trim().replace(/^"|"$/g, ''));
  const phoneIndex = cells.findIndex((c) => PHONE_HEADERS.has(c.toLowerCase()));
  if (phoneIndex === -1) {
    // Headerless CSV: the server names the extra columns col2, col3, …
    return Array.from({ length: cells.length - 1 }, (_, i) => `col${i + 2}`);
  }
  return cells.filter((_, i) => i !== phoneIndex).filter(Boolean);
}

const usedPlaceholders = (body) => [
  ...new Set([...body.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((m) => m[1])),
];

// ---------------------------------------------------------------- compose

function initCompose(form) {
  const body = form.querySelector('#body');
  const recipients = form.querySelector('#recipients');
  const meta = form.querySelector('#bodyMeta');
  const varsMeta = form.querySelector('#varsMeta');
  const savedAt = form.querySelector('#savedAt');
  const draftIdField = form.querySelector('input[name=draftId]');
  const dropzone = form.querySelector('#dropzone');
  const LS_KEY = 'zsb:draft';

  // Second layer of the durability story: even if the server is wiped, the
  // operator's work survives in their own browser.
  const cached = (() => {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) ?? 'null');
    } catch {
      return null;
    }
  })();
  if (cached && !body.value.trim() && (cached.body || cached.recipients)) {
    body.value = cached.body ?? '';
    recipients.value = cached.recipients ?? '';
    savedAt.textContent = 'ブラウザに保存されていた下書きを復元しました';
  }

  function updateMeta() {
    const a = analyze(body.value);
    meta.innerHTML =
      `${a.encoding} / ${body.value.length} 文字 / <b>${a.segments} セグメント</b>` +
      `（1通あたり ${a.perSegment} 文字）` +
      (a.segments > 1 ? ' <span class="warn-text">複数通に分割されて課金されます</span>' : '');
    const lines = recipients.value.split('\n').filter((l) => l.trim() && !l.startsWith('#')).length;
    if (lines) meta.innerHTML += ` ／ 宛先候補 ${lines} 行`;

    updateVars();
  }

  /**
   * The link between "{{name}} in the body" and "a name column in the
   * recipient list" is invisible otherwise — you would only find out at the
   * preview step, after writing the whole message.
   */
  function updateVars() {
    const used = usedPlaceholders(body.value);
    const columns = detectColumns(recipients.value);

    if (!used.length) {
      varsMeta.innerHTML = columns.length
        ? `宛先の列から差し込めます: ${columns.map((c) => `<code>{{${c}}}</code>`).join(' ')}`
        : '';
      return;
    }

    const chips = used
      .map((name) =>
        columns.includes(name)
          ? `<code>{{${name}}}</code> <span class="ok-text">✓</span>`
          : `<code>{{${name}}}</code> <span class="warn-text">⚠️</span>`
      )
      .join('　');

    const missing = used.filter((n) => !columns.includes(n));
    let note = '';
    if (missing.length && !columns.length) {
      note =
        ' — <span class="warn-text">宛先に列がありません。' +
        'ヘッダ付き CSV（例: <code>phone,name,slot</code>）にすると差し込めます</span>';
    } else if (missing.length) {
      note =
        ` — <span class="warn-text">${missing.map((m) => `<code>${m}</code>`).join(', ')}` +
        ` に対応する列がありません（空文字で送信されます）。使える列: ` +
        `${columns.map((c) => `<code>${c}</code>`).join(', ')}</span>`;
    }
    varsMeta.innerHTML = `差し込み変数: ${chips}${note}`;
  }

  let timer;
  function scheduleSave() {
    updateMeta();
    localStorage.setItem(LS_KEY, JSON.stringify({ body: body.value, recipients: recipients.value }));
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/draft', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            draftId: draftIdField.value || null,
            body: body.value,
            recipients: recipients.value,
          }),
        });
        const data = await res.json();
        if (data.id) draftIdField.value = data.id;
        savedAt.textContent = `下書き保存 ${new Date().toLocaleTimeString('ja-JP')}`;
      } catch {
        savedAt.textContent = '下書きをサーバに保存できませんでした（ブラウザには保存済み）';
      }
    }, 2000);
  }

  body.addEventListener('input', scheduleSave);
  recipients.addEventListener('input', scheduleSave);
  form.addEventListener('submit', () => localStorage.removeItem(LS_KEY));
  updateMeta();

  const stop = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  ['dragenter', 'dragover'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      stop(e);
      dropzone.classList.add('over');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      stop(e);
      dropzone.classList.remove('over');
    })
  );
  dropzone.addEventListener('drop', async (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    recipients.value = await file.text();
    scheduleSave();
  });
}

// ----------------------------------------------------------- ③ confirm

function initConfirm(form) {
  const check = form.querySelector('#confirmCheck');
  const btn = form.querySelector('#sendBtn');
  if (!check || !btn || check.disabled) return;
  // The button is rendered enabled so a browser without JS still gets native
  // `required` validation; here we upgrade it to a visibly disabled button.
  const sync = () => {
    btn.disabled = !check.checked;
  };
  check.addEventListener('change', sync);
  sync();
}

// -------------------------------------------------------------------- job

const NOTIFY_KEY = 'zsb:notify';

function initNotifyButton() {
  const btn = document.getElementById('notifyBtn');
  if (!btn || !('Notification' in window)) return;
  btn.hidden = false;

  const armed = () => Notification.permission === 'granted' && localStorage.getItem(NOTIFY_KEY) === 'on';
  const sync = () => {
    if (armed()) {
      btn.textContent = '🔔 完了時に通知します';
      btn.disabled = true;
    }
  };

  btn.addEventListener('click', async () => {
    // Safari only honours requestPermission() from inside a user gesture,
    // which is why this is a button rather than something automatic on load.
    const result =
      Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (result === 'granted') {
      localStorage.setItem(NOTIFY_KEY, 'on');
      sync();
    } else {
      btn.textContent = 'ブラウザ通知がブロックされています';
      btn.disabled = true;
    }
  });
  sync();
}

/** Notifies while the tab is open but unfocused. A closed tab needs the webhook. */
function notifyDone(jobId, counts) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (localStorage.getItem(NOTIFY_KEY) !== 'on') return;
  const n = new Notification('SMS 一括送信が完了しました', {
    body: `Zoom 受理 ${counts.accepted} / 失敗 ${counts.failed} / 不明 ${counts.unknown}`,
    tag: jobId,
  });
  n.onclick = () => {
    window.focus();
    n.close();
  };
}

/** Keeps progress readable from a background tab's title. */
function setTitle(s) {
  document.title = ['done', 'canceled'].includes(s.status)
    ? `✅ 完了 ${s.counts.accepted}/${s.counts.total} — Zoom SMS Bulk`
    : `(${s.counts.done}/${s.counts.total}) 送信中 — Zoom SMS Bulk`;
}

function initJobChrome() {
  const urlEl = document.getElementById('jobUrl');
  const copy = document.getElementById('copyUrl');
  if (!urlEl) return;
  // PUBLIC_URL is optional, so fill in the origin the operator actually used.
  if (urlEl.textContent.trim().startsWith('/')) {
    urlEl.textContent = location.origin + urlEl.textContent.trim();
  }
  copy?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(urlEl.textContent.trim());
      copy.textContent = 'コピーしました';
    } catch {
      copy.textContent = 'コピーできませんでした';
    }
    setTimeout(() => (copy.textContent = 'コピー'), 1500);
  });
}

function initJob(root) {
  const jobId = root.dataset.jobId;
  const bar = document.getElementById('bar');
  const statusEl = document.getElementById('jobStatus');
  const governorEl = document.getElementById('governor');
  const notice = document.getElementById('pauseNotice');
  const log = document.getElementById('liveLog');
  const LABELS = {
    queued: '待機中', running: '送信中', paused: '一時停止', done: '完了', canceled: '中断',
  };
  const OUTCOME = {
    ok: 'Zoom 受理', retryable: '再試行待ち', failed: '失敗',
    terminal: '失敗', ambiguous: '不明', config: '設定エラー',
  };

  initNotifyButton();
  if (['done', 'canceled'].includes(root.dataset.status)) return;

  const es = new EventSource(`/jobs/${jobId}/stream`);
  es.onmessage = (ev) => {
    const s = JSON.parse(ev.data);

    for (const [key, value] of Object.entries(s.counts)) {
      const el = document.querySelector(`[data-count="${key}"]`);
      if (el) el.textContent = value;
    }
    if (s.counts.total) bar.style.width = `${Math.round((s.counts.done / s.counts.total) * 100)}%`;
    setTitle(s);

    statusEl.textContent = LABELS[s.status] ?? s.status;
    statusEl.className = `badge ${s.status}`;

    governorEl.textContent =
      `送信レート ${s.governor.rate}/s（上限 ${s.governor.ceiling}/s）` +
      (s.governor.lastAdjustment ? ` — 直近の調整: ${s.governor.lastAdjustment.reason}` : '') +
      (s.quietHours ? ' ／ 静粛時間帯のため待機中' : '');

    if (s.pauseReason) notice.classList.remove('hidden');

    if (s.last) {
      const li = document.createElement('li');
      li.innerHTML =
        `<span class="muted">#${s.last.seq}</span>` +
        `<span class="mono">${s.last.phone}</span>` +
        `<span>${OUTCOME[s.last.outcome] ?? s.last.outcome}</span>` +
        `<span class="muted small">${s.last.error ?? `${s.last.latencyMs ?? '-'}ms`}</span>`;
      log.prepend(li);
      while (log.children.length > 200) log.lastChild.remove();
    }

    if (['done', 'canceled'].includes(s.status)) {
      es.close();
      notifyDone(jobId, s.counts);
      // Layer 3: put the results in the operator's hands before anything else
      // can go wrong with the server.
      const key = `zsb:downloaded:${jobId}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        const a = document.createElement('a');
        a.href = `/jobs/${jobId}/export.csv`;
        a.download = `sms-${jobId}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      setTimeout(() => location.reload(), 1200);
    }
  };
}

// ------------------------------------------------------------ delivery

/**
 * Polls Zoom for delivery status and repaints the table. Runs once when the
 * page opens (so history rows fill in on their own) and again on demand. The
 * server returns the whole accepted set, so we just repaint every row it names.
 */
function initDelivery(panel) {
  const jobId = panel.dataset.jobId;
  const btn = document.getElementById('refreshDelivery');
  const note = document.getElementById('deliveryNote');

  const paintRow = ({ seq, label, cls }) => {
    const cell = document.querySelector(`[data-delivery-seq="${seq}"]`);
    if (cell) cell.innerHTML = `<span class="pill ${cls}">${label}</span>`;
  };
  const paintTiles = (counts) => {
    for (const key of ['delivered', 'undelivered', 'other', 'unchecked']) {
      const el = document.querySelector(`[data-delivery="${key}"]`);
      if (el) el.textContent = counts[key] ?? 0;
    }
  };

  let running = false;
  async function refresh() {
    if (running) return;
    running = true;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '確認中…';
    }
    try {
      const res = await fetch(`/jobs/${jobId}/delivery`, { method: 'POST' });
      const data = await res.json();
      data.recipients.forEach(paintRow);
      paintTiles(data.counts);
      if (note) {
        const t = new Date().toLocaleTimeString('ja-JP');
        note.dataset.lastChecked = t;
      }
    } catch {
      if (note) note.textContent = '配信状況を取得できませんでした。時間をおいて再度お試しください。';
    } finally {
      running = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = '配信状況を更新';
      }
    }
  }

  btn?.addEventListener('click', refresh);
  // "Fetch when the page opens", as requested.
  refresh();
}

const compose = document.getElementById('compose');
if (compose) initCompose(compose);
const confirmForm = document.getElementById('confirmForm');
if (confirmForm) initConfirm(confirmForm);
const job = document.getElementById('job');
if (job) {
  initJobChrome();
  initJob(job);
}
const deliveryPanel = document.getElementById('deliveryPanel');
if (deliveryPanel) initDelivery(deliveryPanel);
