# Zoom Phone Bulk SMS Sender

> ⚠️ The following sample application is a personal, open-source project shared by the app creator and not an officially supported Zoom Communications, Inc. sample application. Zoom Communications, Inc., its employees and affiliates are not responsible for the use and maintenance of this application. Please use this sample application for inspiration, exploration and experimentation at your own risk and enjoyment. You may reach out to the app creator and broader Zoom Developer community on https://devforum.zoom.us/ for technical discussion and assistance, but understand there is no service level agreement support for this application. Thank you and happy coding!

> ⚠️ このサンプルのアプリケーションは、Zoom Communications, Inc.の公式にサポートされているものではなく、アプリ作成者が個人的に公開しているオープンソースプロジェクトです。Zoom Communications, Inc.とその従業員、および関連会社は、本アプリケーションの使用や保守について責任を負いません。このサンプルアプリケーションは、あくまでもインスピレーション、探求、実験のためのものとして、ご自身の責任と楽しみの範囲でご活用ください。技術的な議論やサポートが必要な場合は、アプリ作成者やZoom開発者コミュニティ（ https://devforum.zoom.us/ ）にご連絡いただけますが、このアプリケーションにはサービスレベル契約に基づくサポートがないことをご理解ください。

---

こんにちは！ 👋
これは **Zoom Phone の 1 つの番号から、たくさんの宛先へ SMS を順番に送る**ための小さな Web アプリです。

CSV や電話番号のリストを貼り付けて、送られる内容をプレビューで確かめてから送信します。
Zoom Phone API（`POST /v2/phone/sms/messages`）を使った実装例として、
「バルク送信を作るとき実際に何を気にすればいいか」を一通り形にしてあります。

ローカルなら **3 コマンドで動きます**。まずは気軽に触ってみてください。

```bash
git clone https://github.com/bitzed/zoom-sms-bulk.git
cd zoom-sms-bulk && npm install
DRY_RUN=true ACCESS_PASSWORD=demo npm start
```

ブラウザで http://localhost:8080 を開けば、そのまま画面を触れます。
`DRY_RUN=true` の間は **Zoom API を一切呼ばず、SMS も送りません**。
Zoom の認証情報がまだ無くても、UI や送信の流れをぜんぶ確認できます。

---

## 🙏 使い始める前に、ひとつだけ

**このツールは「SMS が実際に届いたか」までは確認できません。**

Zoom Phone API が返す成功レスポンスは、「**Zoom がリクエストを受け付けた**」という意味です。
そこから先（キャリア → 相手の端末）は、送信側からは見えません。
とくに日本の Zoom Phone SMS には受信の仕組みがないため、配信レポートや返信で
確認する手段もありません。

なのでこのアプリは「送信成功」ではなく、あえて **「Zoom 受理」** という言葉を使っています。
少し回りくどく感じるかもしれませんが、**「受け付けられた」と「届いた」を混同しない**ことが
このサンプルで一番伝えたかった設計方針です。参考にされる場合も、ここは残していただけると嬉しいです。

---

## 目次

- [できること](#できること)
- [必要なもの](#必要なもの)
- [Zoom アプリを用意する](#zoom-アプリを用意する)
- [実際に送ってみる](#実際に送ってみる)
- [宛先の書き方と差し込み](#宛先の書き方と差し込み)
- [しっかり作り込んだところ](#しっかり作り込んだところ)
- [クラウドに置く](#クラウドに置く)
- [設定一覧](#設定一覧)
- [中身の構成](#中身の構成)
- [できないこと・制限](#できないことや制限)
- [質問・フィードバック](#質問フィードバック)
- [ライセンス](#ライセンス)

---

## できること

- 📋 **CSV / TSV / 電話番号リスト**を貼るだけ。形式は自動で判別します
- 🇯🇵 `090-1234-5678` のような**日本のローカル表記も OK**。E.164 に自動変換します
- 👀 送る前に**必ずプレビュー**。有効・無効・重複の件数、1 通目の実際の文面、所要時間の目安が見えます
- ✏️ **差し込み文** `こんにちは {{name}} さん` に対応
- 📊 送信中は**進捗がライブ表示**。終わったら結果を CSV でダウンロードできます
- 🔁 途中で失敗しても**指数バックオフで自動再試行**、レート制限にもやさしく追従します
- 💾 途中で落ちても**続きから再開**でき、**同じ人に二重送信しません**

ブラウザだけで完結する日本語 UI です。

## 必要なもの

| | |
|---|---|
| **Node.js 22.5 以上** | データベースは Node 内蔵の SQLite を使うので、別途 DB の準備は不要です |
| **Zoom Phone の番号** | SMS が使える、ライセンス済みの番号 |
| **Zoom の Server-to-Server OAuth アプリ** | 次のセクションで作り方を説明します |

Docker や特別なツールは不要です（使いたい方向けの設定は用意してあります）。

## Zoom アプリを用意する

実際に送信するには、Zoom 側で API を呼ぶためのアプリを 1 つ作ります。

1. [Zoom App Marketplace](https://marketplace.zoom.us/) にサインインし、
   **Develop → Build App → Server-to-Server OAuth** を選びます。
2. 作成後、**App Credentials** 画面に表示される
   **Account ID / Client ID / Client Secret** を控えておきます（あとで使います）。
3. **Scopes** で、Zoom Phone の SMS スコープを追加します。
   - SMS メッセージを**読む**スコープ（例: `phone:read:sms_message:admin`）
   - SMS を**送る**スコープ ── `POST /v2/phone/sms/messages` を呼ぶために必要です

   スコープ名は表記が変わることがあるので、Marketplace の画面から検索して選ぶのが確実です。
4. **Activate** でアプリを有効化します。

> 💡 もしスコープが足りなくても大丈夫。送信を始めると最初の 1 通で気づいて
> ジョブ全体が安全に一時停止し、画面に理由が出ます。宛先は 1 件も消費されないので、
> スコープを直して「再開」を押せば続きから流れます。安心して試してください。

## 実際に送ってみる

`DRY_RUN` を外して、控えておいた認証情報を渡します。

```bash
cp env.example .env
# .env を開いて ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET /
# SENDER_NUMBER / ACCESS_PASSWORD を記入
npm start
```

http://localhost:8080 を開くと、次の順に進みます。

| | 画面 | 何をするか |
|---|---|---|
| ① | ゲート | パスワードとお名前を入れ、注意事項に同意します |
| ② | 作成 | 本文と宛先を入力します（文字数・SMS 通数がその場で出ます） |
| ③ | プレビュー | 送信内容を確認します。**ここを通らないと送信できません** |
| ④ | 進捗 | 送信の様子がライブで見えます。一時停止・中断もできます |
| ⑤ | 結果 | 宛先ごとの結果と、CSV ダウンロード、あとで開けるジョブ URL |

まずは**自分の番号 1 件だけ**で試すのがおすすめです。

### Docker で動かす場合

```bash
docker run --rm -p 8080:8080 --env-file .env \
  -v "$PWD/data:/data" ghcr.io/bitzed/zoom-sms-bulk:latest
```

`-v "$PWD/data:/data"` を忘れると、データが消える構成になってしまうため
**アプリ側で起動を止めて教えてくれます**。安心して使ってください。

## 宛先の書き方と差し込み

3 つの形式を自動で見分けます。手元にあるものをそのまま貼ってください。

```csv
phone,name,slot                  ← ① ヘッダ付き CSV / TSV
+818012345678,田中,10:00
090-1234-5678,山田,14:00
```

```
+818012345678,田中,10:00         ← ② ヘッダなし（1 列目が電話番号）
```

```
+818012345678                    ← ③ 1 行に 1 件だけ
090-1234-5678
```

電話番号の列以外は、そのまま本文に差し込めます。

```
こんにちは {{name}} さん。ご予約は {{slot}} です。
```

作成画面では、入力しながら**どの `{{変数}}` が埋まるか**をその場で表示します。

```
差し込み変数: {{name}} ✓  {{slot}} ⚠️ — slot に対応する列がありません（空文字で送信されます）
```

無効な番号や重複は勝手に捨てず、**理由つきでプレビューに一覧表示**するので安心です。

## しっかり作り込んだところ

「バルク送信を自分で書くと地味に大変な部分」を、サンプルとして丁寧に実装しています。

- **順番を守って送る** ── 入力した順にきちんと送信します
- **レート制限にやさしく追従** ── Zoom の上限（Pro: 10通/秒、Business+: 20通/秒）の
  8 割を目安に、レスポンスの残枠を見ながら自動で速度を調整します
- **賢い再試行** ── 一時的なエラー（429 / 5xx / 通信断）だけを、指数バックオフ + ばらつき（jitter）で
  再試行します。`Retry-After` は秒数・日時のどちらの形式にも対応
- **無駄な再試行はしない** ── 番号不正など直しようのないエラーは即座に確定させ、枠を浪費しません
- **二重送信を防ぐ** ── 途中でプロセスが落ちても、続きから再開して同じ人に 2 回送りません。
  タイムアウトのように「送れたか分からない」ものは自動再送せず、人の判断に委ねます
- **データを失わない** ── 原稿はブラウザとサーバの両方に自動保存。
  結果は完了時に CSV で自動ダウンロードされ、ジョブ URL からいつでも見返せます

技術的な詳細はコード中のコメントに書いてあります。テストも
`npm test` で走り、再試行・順序・二重送信防止・復帰などをカバーしています。

## クラウドに置く

社内の人にブラウザだけで使ってもらいたい場合は、PaaS に置くのが手軽です。
ボタンからそのままデプロイできます。

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https://github.com/bitzed/zoom-sms-bulk)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/bitzed/zoom-sms-bulk)

- **Railway** … デプロイ後、ダッシュボードで `/data` にボリュームを 1 つ追加してください
- **Render** … [render.yaml](render.yaml) にディスク込みで定義済み（`starter` プラン以上が必要）
- **Fly.io** … [fly.toml](fly.toml) で東京リージョン（`nrt`）に置けます

どのサービスでも共通のポイントが 2 つあります（設定ファイル側で守るようにしてあります）。

1. **`/data` に永続ストレージを付ける** ── 付いていないとアプリが起動を止めて教えます
2. **インスタンスは 1 つだけにする** ── 2 つ動かすと、お互いの送信状況を知らないまま
   別々に送ってしまうためです

環境変数は各サービスの「Secret／環境変数」機能でそのまま渡せます
（アプリはクラウド固有の SDK を一切使っていません）。
なお **Heroku はファイルが再起動で消える**ため、あえて対象外にしています。

## 設定一覧

すべて環境変数です（`.env` ファイルでも OK）。詳しい注釈は [env.example](env.example) にあります。

**必須**

| 変数 | 説明 |
|---|---|
| `ACCESS_PASSWORD` | 画面を開くための共有パスワード。未設定だと起動しません |
| `ZOOM_ACCOUNT_ID` / `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` | Server-to-Server OAuth の値 |
| `SENDER_NUMBER` | 送信元番号（E.164、例 `+818012345678`） |

（`DRY_RUN=true` のときは Zoom の 4 つは不要です）

**よく使うもの**

| 変数 | 既定 | 説明 |
|---|---|---|
| `DRY_RUN` | `false` | `true` で Zoom API を呼ばずにお試し |
| `ZOOM_PLAN` | `pro` | 送信レートの目安。`pro` → 8通/秒、`business` → 16通/秒 |
| `CONCURRENCY` | `1` | 同時送信数（1〜8）。上げると速くなります |
| `MAX_RECIPIENTS_PER_JOB` | `200` | 1 回の上限（事故防止） |
| `QUIET_HOURS` | `21-8` | この時間帯（JST）は送信を控えます。空で無効 |
| `DATA_DIR` | `./data` | データの保存先 |
| `NOTIFY_WEBHOOK_URL` | — | 完了・停止時に Slack 互換の通知を送ります（任意） |

再試行やトークンまわりの細かい調整項目もあります。すべて [env.example](env.example) を参照してください。

## 中身の構成

```
src/
├── server.js          Web サーバー（画面・進捗配信・CSV 出力など）
├── cli.js             起動エントリ
├── config.js          設定の読み込みと起動時チェック
├── core/              本体ロジック（プラットフォーム非依存）
│   ├── parse.js       CSV/リスト → 電話番号の正規化・重複除去
│   ├── template.js    {{変数}} の差し込み、文字数・SMS 通数の計算
│   ├── store.js       SQLite（Node 内蔵）
│   ├── governor.js    送信レートの調整
│   ├── backoff.js     再試行の待ち時間
│   └── runner.js      送信の司令塔
├── zoom/              Zoom API クライアント（OAuth / SMS 送信）
└── ui/                画面（サーバー描画の HTML + 素の JS + CSS。ビルド不要）
```

実行時の依存は `hono` / `zod` / `csv-parse` / `libphonenumber-js` / `pino` の 5 つだけ。
フロントエンドには依存パッケージがありません。

```bash
npm run dev     # 開発用（自動リロード）
npm test        # テスト
```

## できないことや制限

はじめに知っておいていただくと安心です。

- **配信の到達確認はできません**（冒頭のとおり）
- **受信 SMS は扱えません**。そのため `STOP` の自動処理はなく、送信除外リストは手動運用です
- **添付ファイル（MMS）には対応していません**
- **同時に 1 インスタンスまで**。大規模・オートスケール運用には別途 DB（Postgres）対応が必要です
- **ログインは共有パスワードのみ**。社内で URL を限定共有する用途を想定しています
- **UI は日本語のみ**です
- これは検証・学習用のサンプル（PoC）です。丁寧に作っていますが、その前提でご利用ください

## 質問・フィードバック

- Zoom API まわりの質問や技術的な相談は
  **[Zoom 開発者フォーラム](https://devforum.zoom.us/)** へどうぞ。コミュニティで話せます
- このリポジトリ自体へのバグ報告・提案は
  [GitHub Issues](https://github.com/bitzed/zoom-sms-bulk/issues) へお気軽に

冒頭の注意書きのとおり、公式サポート（SLA）はありませんが、
フィードバックはいつでも歓迎です。楽しんでいただけたら嬉しいです！ 🎉

## ライセンス

MIT ── [LICENSE](LICENSE) をご覧ください。
