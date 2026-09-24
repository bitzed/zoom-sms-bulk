import { analyze, render, placeholders } from '../core/template.js';

export const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const RECIPIENT_STATUS = {
  pending: { label: '待機', cls: 'muted' },
  sending: { label: '送信中', cls: 'busy' },
  retry_wait: { label: '再試行待ち', cls: 'warn' },
  // Deliberately not "送信成功": Zoom accepting the request is all we observe.
  accepted: { label: 'Zoom 受理', cls: 'ok' },
  failed: { label: '失敗', cls: 'bad' },
  skipped: { label: '対象外', cls: 'muted' },
  unknown: { label: '不明', cls: 'warn' },
};

export const JOB_STATUS = {
  queued: '待機中',
  running: '送信中',
  paused: '一時停止',
  done: '完了',
  canceled: '中断',
};

// Delivery status as reported by Zoom's SMS message-detail endpoint. This is a
// step beyond "accepted" — it is what Zoom knows about the message reaching the
// carrier/handset — but it is still Zoom's view, not a guarantee of the phone.
export const DELIVERY_STATUS = {
  delivered: { label: '配信済み', cls: 'ok' },
  received: { label: '受信', cls: 'ok' },
  undelivered: { label: '不達', cls: 'bad' },
  failed: { label: '配信失敗', cls: 'bad' },
  sent: { label: '送出済み', cls: 'warn' },
  queued: { label: 'キュー待ち', cls: 'warn' },
  sending: { label: '配信中', cls: 'warn' },
  pending: { label: '確認中', cls: 'warn' },
};

/** Raw delivery_status (or null) → a { label, cls } the UI can render. */
export function deliveryView(raw) {
  if (raw == null) return { label: '未確認', cls: 'muted', raw: null };
  return { ...(DELIVERY_STATUS[raw] ?? { label: raw, cls: 'muted' }), raw };
}

const PAUSE_REASON = {
  daily_limit: '日次レート上限に達しました',
  circuit: '連続失敗が続いたため安全のため停止しました',
  manual: '手動で一時停止しました',
  config_error:
    '認証・権限エラーです。Client ID / Client Secret / Account ID、SMS 送信スコープ、プラン、' +
    '送信番号の設定を確認してください。未送信分はそのまま残っているので、直したら再開できます',
  restarted: 'プロセスが再起動しました。未送信分は保持されています',
  stopped: '処理が中断されました',
  error: '内部エラーが発生しました',
};

function banners(ctx) {
  const out = [];
  if (ctx.config.safety.dryRun) {
    out.push(
      `<div class="banner dry">🧪 <b>DRY-RUN モード</b> — Zoom API は呼ばれません。実際の SMS は送信されません。</div>`
    );
  }
  const s = ctx.config.storage;
  if (s.mode === 'ephemeral') {
    out.push(
      `<div class="banner danger">⚠️ <b>一時ストレージで動作中</b> — 再起動すると原稿・宛先・送信履歴はすべて消えます${
        s.ephemeralPlatform ? `（${esc(s.ephemeralPlatform)}）` : ''
      }。結果 CSV は必ず手元に保存してください。</div>`
    );
  } else if (!s.proven) {
    out.push(
      `<div class="banner info">ℹ️ データディレクトリは初回起動です。永続化は次回起動時に確認されます（<code>${esc(
        s.dataDir
      )}</code>）。</div>`
    );
  }
  return out.join('');
}

function layout({ title, body, ctx, nav = true }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — Zoom SMS Bulk</title>
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
<header class="topbar">
  <div class="brand">Zoom Phone <b>Bulk SMS</b> <span class="tag">PoC</span></div>
  ${
    nav
      ? `<nav>
      <a href="/compose">新規作成</a>
      <a href="/jobs">履歴</a>
      <a href="/dnc">送信除外</a>
      <form method="post" action="/logout"><button class="linkish" type="submit">終了</button></form>
    </nav>`
      : ''
  }
</header>
<main>
${banners(ctx)}
${body}
</main>
<script type="module" src="/assets/app.js"></script>
</body>
</html>`;
}

// ---------------------------------------------------------------- ① Gate

export function gatePage(ctx, { error, operator } = {}) {
  const body = `
<section class="card narrow">
  <h1>ご利用前に必ずお読みください</h1>
  <div class="disclaimer">
    <ul>
      <li>これは <b>PoC（検証目的の試作）</b>です。動作および配信を保証するものではありません。</li>
      <li><b>「Zoom 受理」＝「相手に届いた」ではありません。</b>日本の Zoom Phone SMS には
          受信・配信確認の仕組みがなく、本ツールは実際の到達を確認できません。</li>
      <li><b>送信は取り消せません。</b>宛先と本文を必ず確認してください。</li>
      <li>1 ジョブあたり最大 <b>${ctx.config.safety.maxRecipientsPerJob}</b> 件です。</li>
      <li>実行者名・送信内容・送信結果は監査ログとして記録されます。</li>
      ${
        ctx.config.safety.quietHours
          ? `<li>${ctx.config.safety.quietHours.start}時〜${ctx.config.safety.quietHours.end}時（JST）は送信されず待機します。</li>`
          : ''
      }
    </ul>
  </div>
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  <form method="post" action="/gate" class="stack">
    <label>実行者名
      <input name="operator" required autocomplete="name" value="${esc(operator ?? '')}">
    </label>
    <label>パスワード
      <input name="password" type="password" required autocomplete="current-password">
    </label>
    <label class="check">
      <input type="checkbox" name="agreed" value="1" required>
      <span>上記を理解しました</span>
    </label>
    <button class="primary" type="submit">開始する</button>
  </form>
</section>`;
  return layout({ title: 'Gate', body, ctx, nav: false });
}

// ------------------------------------------------------------- ② Compose

export function composePage(ctx, { draft }) {
  const body = `
<section class="card">
  <h1>① 原稿と宛先</h1>
  <form method="post" action="/preview" class="stack" id="compose"
        data-draft-id="${esc(draft?.id ?? '')}">
    <input type="hidden" name="draftId" value="${esc(draft?.id ?? '')}">

    <div class="row">
      <label class="grow">送信元番号
        <input value="${esc(ctx.config.zoom.senderNumber)}" disabled>
        <small>環境変数 <code>SENDER_NUMBER</code> で固定されています</small>
      </label>
      <label>同時実行数
        <select name="concurrency">
          ${[1, 2, 4, 8]
            .map(
              (n) =>
                `<option value="${n}" ${n === ctx.config.rate.concurrency ? 'selected' : ''}>${n}</option>`
            )
            .join('')}
        </select>
        <small>開始順は入力順のまま</small>
      </label>
    </div>

    <label>本文
      <textarea name="body" id="body" rows="6" required
        placeholder="こんにちは {{name}} さん。ご予約は {{slot}} です。">${esc(draft?.body ?? '')}</textarea>
      <small>下の宛先を <b>ヘッダ付き CSV</b> にすると、<code>phone</code> 以外の列名を
        <code>{{name}}</code> のように書いて 1 通ずつ差し込めます。対応する列が無い場合は空文字になります。</small>
    </label>
    <div class="meta" id="bodyMeta"></div>
    <div class="meta" id="varsMeta"></div>

    <label>宛先
      <textarea name="recipients" id="recipients" rows="10" required
        placeholder="+818012345678&#10;090-1234-5678&#10;&#10;または CSV:&#10;phone,name,slot&#10;+818012345678,田中,10:00"></textarea>
      <small>CSV / TSV（ヘッダ有無どちらも可）または 1 行 1 件のリスト。日本の番号はローカル表記のまま貼れます。</small>
    </label>
    <div class="dropzone" id="dropzone">CSV ファイルをここにドロップ</div>

    <div class="row end">
      <span class="saved" id="savedAt"></span>
      <button class="primary" type="submit">② 内容を確認する</button>
    </div>
  </form>
</section>`;
  return layout({ title: '新規作成', body, ctx });
}

// ------------------------------------------------------------- ③ Preview

function estimateSeconds(count, rate, concurrency) {
  const byRate = count / rate;
  const byLatency = (count * 0.4) / concurrency; // ~400ms per request
  return Math.ceil(Math.max(byRate, byLatency));
}

function rejectTable(title, items, columns) {
  if (!items.length) return '';
  return `<details class="reject"><summary>${esc(title)}（${items.length} 件）</summary>
  <table><thead><tr>${columns.map((c) => `<th>${esc(c[0])}</th>`).join('')}</tr></thead>
  <tbody>${items
    .slice(0, 200)
    .map((it) => `<tr>${columns.map((c) => `<td>${esc(c[1](it))}</td>`).join('')}</tr>`)
    .join('')}</tbody></table>
  ${items.length > 200 ? `<p class="muted">先頭 200 件のみ表示</p>` : ''}</details>`;
}

export function previewPage(ctx, { draft, parsed, concurrency, blockingError }) {
  const stats = analyze(draft.body);
  const sample = parsed.rows[0];
  const used = placeholders(draft.body);
  const missing = sample
    ? used.filter((k) => !(k in (sample.vars ?? {})) || sample.vars[k] === '')
    : used;
  const seconds = estimateSeconds(parsed.rows.length, ctx.config.rate.ceiling, concurrency);
  const pretty = seconds < 90 ? `約 ${seconds} 秒` : `約 ${Math.ceil(seconds / 60)} 分`;

  const body = `
<section class="card">
  <h1>② 送信内容の確認</h1>

  <div class="tiles">
    <div class="tile ok"><b>${parsed.rows.length}</b><span>送信対象</span></div>
    <div class="tile ${parsed.invalid.length ? 'bad' : 'muted'}"><b>${parsed.invalid.length}</b><span>無効</span></div>
    <div class="tile ${parsed.duplicates.length ? 'warn' : 'muted'}"><b>${parsed.duplicates.length}</b><span>重複</span></div>
    <div class="tile ${parsed.blocked.length ? 'warn' : 'muted'}"><b>${parsed.blocked.length}</b><span>送信除外</span></div>
    <div class="tile muted"><b>${pretty}</b><span>推定所要時間</span></div>
  </div>

  <h2>本文</h2>
  <div class="preview-body">${esc(draft.body)}</div>
  <p class="meta">${stats.encoding} / ${stats.chars} 文字 / <b>${stats.segments} セグメント</b>
     （1通あたり ${stats.perSegment} 文字）
     ${stats.segments > 1 ? '<span class="warn-text">複数通に分割されて課金されます</span>' : ''}</p>

  ${
    sample
      ? `<h2>1 件目の実際の送信内容</h2>
  <div class="preview-body rendered">${esc(render(draft.body, sample.vars))}</div>
  <p class="meta">宛先: <code>${esc(sample.phone)}</code>（入力: ${esc(sample.raw)}）</p>`
      : ''
  }
  ${
    missing.length
      ? `<p class="error">差し込み変数 ${missing
          .map((m) => `<code>{{${esc(m)}}}</code>`)
          .join(' ')} に対応する列が見つかりません。空文字として送信されます。</p>`
      : ''
  }

  <h2>正規化結果</h2>
  <table class="grid">
    <thead><tr><th>#</th><th>入力</th><th>E.164</th><th>国</th><th>差し込み</th></tr></thead>
    <tbody>
    ${parsed.rows
      .slice(0, 100)
      .map(
        (r) => `<tr><td>${r.seq}</td><td class="mono">${esc(r.raw)}</td>
        <td class="mono strong">${esc(r.phone)}</td><td>${esc(r.country ?? '?')}</td>
        <td class="mono small">${esc(
          Object.entries(r.vars ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')
        )}</td></tr>`
      )
      .join('')}
    </tbody>
  </table>
  ${parsed.rows.length > 100 ? `<p class="muted">先頭 100 件のみ表示（全 ${parsed.rows.length} 件）</p>` : ''}

  ${rejectTable('無効な番号', parsed.invalid, [
    ['行', (i) => i.line],
    ['入力', (i) => i.raw || '(空)'],
    ['理由', (i) => i.reason],
  ])}
  ${rejectTable('重複（先に出現した行を採用）', parsed.duplicates, [
    ['行', (i) => i.line],
    ['入力', (i) => i.raw],
    ['E.164', (i) => i.phone],
  ])}
  ${rejectTable('送信除外リスト該当', parsed.blocked, [
    ['行', (i) => i.line],
    ['E.164', (i) => i.phone],
    ['理由', (i) => i.reason],
  ])}

  ${blockingError ? `<p class="error big">${esc(blockingError)}</p>` : ''}

  <form method="post" action="/send" class="confirm-bar" id="confirmForm">
    <input type="hidden" name="draftId" value="${esc(draft.id)}">
    <input type="hidden" name="concurrency" value="${concurrency}">
    <a class="ghost" href="/compose">← 修正する</a>
    <label class="check">
      <input type="checkbox" name="confirm" value="1" id="confirmCheck" required
             ${blockingError ? 'disabled' : ''}>
      <span>宛先 <b>${parsed.rows.length}</b> 件と本文を確認しました</span>
    </label>
    <button class="primary danger-action" type="submit" id="sendBtn" ${blockingError ? 'disabled' : ''}>
      ${ctx.config.safety.dryRun ? '③ DRY-RUN を実行' : '③ 送信を開始する'}
    </button>
  </form>
</section>`;
  return layout({ title: '確認', body, ctx });
}

// -------------------------------------------------- ④⑤ Progress / Result

export function jobPage(ctx, { job, counts, recipients }) {
  const terminal = job.status === 'done' || job.status === 'canceled';
  const body = `
<section class="card" id="job" data-job-id="${esc(job.id)}" data-status="${esc(job.status)}">
  <h1>${terminal ? '④ 送信結果' : '④ 送信中'}
    <span class="badge ${esc(job.status)}" id="jobStatus">${esc(JOB_STATUS[job.status] ?? job.status)}</span>
  </h1>
  <p class="meta">
    ジョブ <code>${esc(job.id)}</code> ／ 実行者 <b>${esc(job.operator)}</b> ／
    送信元 <code>${esc(job.sender)}</code> ／ ${esc(new Date(job.created_at).toLocaleString('ja-JP'))}
    ${job.dry_run ? '<span class="badge dry">DRY-RUN</span>' : ''}
  </p>

  <div id="pauseNotice" class="banner warn ${job.pause_reason ? '' : 'hidden'}">
    ⏸ ${esc(PAUSE_REASON[job.pause_reason] ?? job.pause_reason ?? '')}
    ${job.resume_at ? `（${esc(new Date(job.resume_at).toLocaleString('ja-JP'))} 以降に再開できます）` : ''}
  </div>

  <div class="progress"><div class="bar" id="bar" style="width:${
    counts.total ? Math.round((counts.done / counts.total) * 100) : 0
  }%"></div></div>

  <div class="tiles" id="tiles">
    <div class="tile ok"><b data-count="accepted">${counts.accepted}</b><span>Zoom 受理</span></div>
    <div class="tile warn"><b data-count="retry_wait">${counts.retry_wait}</b><span>再試行待ち</span></div>
    <div class="tile bad"><b data-count="failed">${counts.failed}</b><span>失敗</span></div>
    <div class="tile warn"><b data-count="unknown">${counts.unknown}</b><span>不明</span></div>
    <div class="tile muted"><b data-count="pending">${counts.pending}</b><span>未送信</span></div>
    <div class="tile muted"><b data-count="total">${counts.total}</b><span>合計</span></div>
  </div>
  <p class="meta" id="governor"></p>

  ${
    job.dry_run
      ? ''
      : `<div class="delivery-panel" id="deliveryPanel" data-job-id="${esc(job.id)}">
    <div class="delivery-head">
      <h2>配信状況 <small>（Zoom 調べ・参考値）</small></h2>
      <button class="ghost small" id="refreshDelivery" type="button">配信状況を更新</button>
    </div>
    <div class="tiles">
      <div class="tile ok"><b data-delivery="delivered">–</b><span>配信済み</span></div>
      <div class="tile bad"><b data-delivery="undelivered">–</b><span>不達</span></div>
      <div class="tile warn"><b data-delivery="other">–</b><span>配信中ほか</span></div>
      <div class="tile muted"><b data-delivery="unchecked">–</b><span>未確認</span></div>
    </div>
    <p class="meta" id="deliveryNote">
      Zoom が受理したメッセージについて、実際の配信状況を Zoom API から取得します。
      「配信済み」も Zoom が報告する状態であり、相手端末での着信を保証するものではありません。
    </p>
  </div>`
  }

  <div class="actions">
    <a class="primary" href="/jobs/${esc(job.id)}/export.csv" id="download">結果 CSV をダウンロード</a>
    ${
      job.status === 'running'
        ? `<form method="post" action="/jobs/${esc(job.id)}/pause"><button>一時停止</button></form>
           <form method="post" action="/jobs/${esc(job.id)}/cancel"><button class="ghost">中断</button></form>`
        : ''
    }
    ${
      job.status === 'paused'
        ? `<form method="post" action="/jobs/${esc(job.id)}/resume"><button class="primary">再開</button></form>
           <form method="post" action="/jobs/${esc(job.id)}/cancel"><button class="ghost">中断</button></form>`
        : ''
    }
    ${
      terminal && counts.failed + counts.unknown > 0
        ? `<form method="post" action="/jobs/${esc(job.id)}/retry"
             onsubmit="return confirm('「不明」は既に送信済みの可能性があります。再送すると相手に2通届く場合があります。続行しますか？')">
             <button>失敗・不明の ${counts.failed + counts.unknown} 件を再送</button></form>`
        : ''
    }
    ${terminal ? '' : `<button class="ghost" id="notifyBtn" type="button" hidden>🔔 完了時にブラウザ通知</button>`}
  </div>

  <p class="meta keepalive">
    ${
      terminal
        ? 'この結果は保存されています。'
        : '<b>このページを閉じても送信はサーバ側で続きます。</b>進捗のライブ表示と自動ダウンロードが止まるだけです。'
    }
    結果はいつでも <a href="/jobs">送信履歴</a> から、またはこの URL で開けます
    — <code id="jobUrl">${esc(ctx.config.notify.publicUrl ?? '')}/jobs/${esc(job.id)}</code>
    <button class="linkish" id="copyUrl" type="button">コピー</button>
  </p>

  <div id="live" class="live ${terminal ? 'hidden' : ''}"><h2>ライブログ</h2><ul id="liveLog"></ul></div>

  <h2>宛先一覧</h2>
  <table class="grid">
    <thead><tr><th>#</th><th>宛先</th><th>状態</th>${
      job.dry_run ? '' : '<th>配信状況</th>'
    }<th>試行</th><th>message_id</th><th>詳細</th></tr></thead>
    <tbody>
    ${recipients
      .map((r) => {
        const s = RECIPIENT_STATUS[r.status] ?? { label: r.status, cls: 'muted' };
        const d = deliveryView(r.delivery_status);
        // Only accepted, real sends can have a delivery status to show or poll.
        const deliverable = r.status === 'accepted' && r.session_id && r.session_id !== 'dry-run';
        const deliveryCell = job.dry_run
          ? ''
          : `<td data-delivery-seq="${r.seq}">${
              deliverable
                ? `<span class="pill ${d.cls}">${esc(d.label)}</span>`
                : '<span class="muted small">—</span>'
            }</td>`;
        return `<tr><td>${r.seq}</td><td class="mono">${esc(r.phone)}</td>
        <td><span class="pill ${s.cls}" ${
          r.status === 'accepted'
            ? 'title="Zoom API がリクエストを受理しました。相手の端末への着信を保証するものではありません"'
            : r.status === 'unknown'
              ? 'title="タイムアウトのため送信されたかどうか判定できません"'
              : ''
        }>${esc(s.label)}</span></td>${deliveryCell}
        <td>${r.attempts}</td><td class="mono small">${esc(r.message_id ?? '')}</td>
        <td class="small">${esc(r.last_error ?? '')}</td></tr>`;
      })
      .join('')}
    </tbody>
  </table>
</section>`;
  return layout({ title: '送信', body, ctx });
}

export function jobsPage(ctx, { jobs }) {
  const body = `
<section class="card">
  <h1>送信履歴</h1>
  ${
    jobs.length === 0
      ? '<p class="muted">まだ送信履歴はありません。</p>'
      : `<table class="grid">
    <thead><tr><th>日時</th><th>実行者</th><th>状態</th><th>受理/合計</th><th></th></tr></thead>
    <tbody>${jobs
      .map(
        (j) => `<tr>
      <td>${esc(new Date(j.created_at).toLocaleString('ja-JP'))}</td>
      <td>${esc(j.operator)}</td>
      <td><span class="pill ${j.status === 'done' ? 'ok' : j.status === 'canceled' ? 'bad' : 'warn'}">${esc(
        JOB_STATUS[j.status] ?? j.status
      )}</span>${j.dry_run ? ' <span class="badge dry">DRY</span>' : ''}</td>
      <td>${j.accepted} / ${j.total}</td>
      <td><a href="/jobs/${esc(j.id)}">開く</a></td></tr>`
      )
      .join('')}</tbody></table>`
  }
</section>`;
  return layout({ title: '履歴', body, ctx });
}

export function dncPage(ctx, { entries }) {
  const body = `
<section class="card narrow">
  <h1>送信除外リスト</h1>
  <p class="muted">日本の Zoom Phone SMS には受信の仕組みがないため、STOP 返信による自動オプトアウトは
  利用できません。除外したい番号は手動で登録してください。取り込み時に必ず照合されます。</p>
  <form method="post" action="/dnc" class="row">
    <input name="phone" placeholder="+818012345678 / 090-1234-5678" required class="grow">
    <input name="reason" placeholder="理由（任意）">
    <button class="primary" type="submit">追加</button>
  </form>
  ${
    entries.length === 0
      ? '<p class="muted">登録なし</p>'
      : `<table class="grid"><thead><tr><th>番号</th><th>理由</th><th>登録者</th><th></th></tr></thead>
    <tbody>${entries
      .map(
        (e) => `<tr><td class="mono">${esc(e.phone)}</td><td>${esc(e.reason)}</td>
      <td>${esc(e.added_by ?? '')}</td>
      <td><form method="post" action="/dnc/delete"><input type="hidden" name="phone" value="${esc(
        e.phone
      )}"><button class="linkish">削除</button></form></td></tr>`
      )
      .join('')}</tbody></table>`
  }
</section>`;
  return layout({ title: '送信除外', body, ctx });
}

export function errorPage(ctx, { title, message, backTo = '/compose' }) {
  const body = `<section class="card narrow">
  <h1>${esc(title)}</h1>
  <p class="error big">${esc(message)}</p>
  <p><a class="ghost" href="${esc(backTo)}">← 戻る</a></p>
</section>`;
  return layout({ title, body, ctx });
}
