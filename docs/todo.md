# TODO / 現在地

最終更新: 2026-09-10

設計・仕様は [design.md](./design.md) が正本。このファイルは**どこまで終わったか**と**次に何をするか**だけを持つ。

---

## 進捗

design.md「実装の進め方」の4段階に対する現在地。

| 段階 | 状態 | 備考 |
|---|---|---|
| 1. 疎通確認 | **完了** | `/api/health/firestore` が `ok: true`。Firestore への書き込みを確認済み |
| 2. 認証 | **完了** | Google ログインが通り、`users/{uid}` が作成されることを確認済み |
| 3. データ層 | コードは実装済み / **未検証** | `lib/` 9ファイル・Route Handler 4本とも配置済み。実データでの確認がまだ |
| 4. UI | コードは実装済み / **未検証** | 対話版 `/`、共通コンポーネント、統制群 `/kws` の新API移行とも配置済み |

`npm run build`（型チェック）と `npm run lint` は通っている。残っているのは**実データで一度も通していない**こと。

### ルート構成（2026-09-09 に入れ替え）

| ルート | 中身 |
|---|---|
| **`/`** | **対話版（既定）**。コルトハーヘンの ALACT モデルに沿った6ステージ対話 |
| **`/kws`** | KWS フォーム版（統制群 / `condition: "form"`）。リンクを直接指定して入る |
| `/session` | `/` への転送。旧ルートのブックマーク対策 |

対話版は画面上に Keep/Problem のテキストエリアが無く、AI の固定の開口一番から始まって6ステージを1問ずつ進む。
`sessions.keep` / `sessions.problem` への格納は、統制群と列を揃えるための裏側の処理（[messages/route.ts](../app/api/sessions/%5BsessionId%5D/messages/route.ts) のステージ分岐）。

---

## 2026-09-09 に入れた修正（LLM を Claude API に変更）

AI を Gemini から **Claude API（公式 SDK `@anthropic-ai/sdk`）** に載せ替えた。
差分と根拠は [prompt-design.md](./prompt-design.md) の「変更履歴」が正本。

- [x] `lib/claude.ts` を新規作成し、`lib/gemini.ts` を削除
  - ストリーミングで受けて最終メッセージを取る（生成が長引いても HTTP のタイムアウトに当たらない）
  - `max_tokens: 8000` / クライアント側 50 秒で打ち切り。Vercel の `maxDuration = 60` を超える前に日本語のエラーを返すため
  - SDK の例外（認証・レート制限・タイムアウト・接続失敗）を `ClaudeError` に変換。詳細はサーバーログにだけ出す
  - `stop_reason: "refusal"` は HTTP 200 で返ってくるので、例外ではなく戻り値で判定している
- [x] `lib/conversation.ts` / `lib/repository.ts` / `lib/route-utils.ts` を新しいラッパに繋ぎ替え
  - AI 側の role が `model` → `assistant` に変わった
- [x] **`temperature` を廃止し `effort` に置き換えた**（Claude Sonnet 5 / Opus 5 では temperature を送ると 400）
  - `sessions.temperature` → `sessions.effort`
  - `lib/prompts/v2.ts` の `TEMPERATURE` を削除
  - **論文の書き方に影響する。** 「低温度で問いの揺らぎを抑えている」という説明はもう使えない
- [x] `messages.usage` の中身を改名（`promptTokens`/`candidatesTokens` → `inputTokens`/`outputTokens`、キャッシュ分を追加）
- [x] `.env.example` / `docs/design.md` / `docs/prompt-design.md` を更新
- [x] `npm run build` / `npm run lint` を通した
- [ ] **実 API での動作確認はまだ**（下の「次にやること」の 0 番）

**プロンプトの文面は変えていない。** `PROMPT_VERSION` は `v2` のまま。

---

## 2026-09-09 に入れた修正（プロンプト v2）

添削を受けてプロンプト内部の論理矛盾3件を解消した。差分と根拠は [prompt-design.md](./prompt-design.md) の「変更履歴」が正本。

- [x] `lib/prompts/v2.ts` を新規作成（`v1.ts` は残置・書き換えない）
  - 締めの固定文言を「気づき or 問題」の二択から自省への着地に一本化
  - `feeling_other` を他者視点に一本化（「問いは1つ」制約との矛盾を解消）
  - Try 生成に「新しい助言を追加しない／本人の発話を再構成する」を明文化
- [x] `lib/prompts/index.ts` を新規作成し、版の切り替えを1行に集約
  - 以前は4ファイルが `@/lib/prompts/v1` を直接 import しており、版を上げるときの直し漏れが起きうる状態だった
  - 呼び出し側は全て `@/lib/prompts` 経由に変更済み
- [x] `npm run build` / `npm run lint` を通した（実データでの確認はこれから）

**ルート構成の入れ替え（同日）** — 対話版を既定の体験にした。

- [x] `/` = 対話版、`/kws` = KWS フォーム版、`/session` = `/` へ転送
- [x] `app/session/dialogue-workspace.tsx` → `app/dialogue-workspace.tsx`
- [x] `app/reflection-workspace.tsx` → `app/kws/kws-workspace.tsx`（`KwsWorkspace` に改名）
- [x] 画面上のステージ表示を v2 に合わせた（「感情と相手の視点」→「相手の視点」、「気づき」→「本当の課題」）
- [x] 両画面の相互リンクと、コード上の「KPT」表記を「KWS」に統一

---

## 2026-08-17 に入れた修正

予備実験が UI/UX 調査中心なので、**参加者が自力で復帰できない詰まり方**を優先して潰した。

- [x] `app/api/health/firestore/route.ts` を削除（段階1の一時ファイル）
- [x] AuthGate のログイン確認に8秒の打ち切りを追加
  - 以前は `onAuthStateChanged` が発火しないと「ログイン状態を確認しています...」から二度と戻れなかった
  - 打ち切り後も購読は継続。遅れて発火したら正しい状態に自動で戻る
- [x] localStorage の下書きキーを uid ごとに分離
  - 共有 PC で別の人がログインすると前の人のセッションが復元され、送信が全て 404 になって詰んでいた
- [x] 404（セッションが存在しない）を受けたら下書きを捨てて最初からやり直せるように
- [x] `POST /api/sessions/[sessionId]/abandon` を追加し、「中断する」「すべてリセット」で `status: "abandoned"` を書く
  - 以前は離脱セッションが `active` のまま残り、進行中と区別できなかった
  - ブラウザを閉じただけの離脱は捕まえられない（`beforeunload` は信用できない）
- [x] `postJson` を AuthGate に集約（両ワークスペースで重複していた）。`ApiError` で status を持つ

---

## 次にやること

### 0. Claude の APIキーを入れる（これが無いと何も動かない）

`.env.local` の**枠は 2026-09-10 に用意済み**（先頭に `ANTHROPIC_API_KEY` / `CLAUDE_MODEL` / `CLAUDE_EFFORT` の3行、
`GEMINI_*` の2行はコメントアウト）。残りは**キーの値を貼るだけ**。

```
ANTHROPIC_API_KEY=sk-ant-...   ← ここに貼る
CLAUDE_MODEL=claude-sonnet-5
CLAUDE_EFFORT=medium
```

キーの取得は https://platform.claude.com/ → Settings → API keys。
`CLAUDE_MODEL` と `CLAUDE_EFFORT` は省略可（既定は同じ値）。
キーが無いまま送信すると「ANTHROPIC_API_KEY が未設定です。」が 500 で返る。

- [ ] `.env.local` の `ANTHROPIC_API_KEY=` にキーを貼る
- [ ] `node scripts/claude-smoke.mjs` で疎通確認（アプリを起動せずに応答・レイテンシ・トークン数・概算費用が出る）
- [ ] `npm run dev` を再起動して 1往復（**費用が発生する。ここで初めて課金が始まる**）
- [ ] 応答の待ち時間が実用的か確認。長すぎるなら `CLAUDE_EFFORT=low` に下げる
- [ ] 使わなくなった Gemini のキーを Google AI Studio 側で失効させる

### 1. 段階3・4 を検証する（AI対話版）

```
npm run dev  →  http://localhost:3000/
```

- [ ] `/` を開くと対話版が出る／`/kws` で KWS フォーム版が出る／`/session` が `/` に転送される
- [ ] 対話を6ステージ最後まで一周する
- [ ] ステージ6で**固定文言**が出る（2回試して一字一句同じことを確認）
  - v2 の文面「今日の対話を通して、あなた自身が主体的に向き合うべき『本当の課題』は…」になっていること
- [ ] ステージ4（`feeling_other`）の生成が**1問だけ**になっている（v1 では2問に割れることがあった）
- [ ] Try に、対話で出ていない一般論の助言が混ざっていない
- [ ] `sessions.promptVersion` が `"v2"` で入っている
- [ ] Firestore コンソールで確認:
  - [ ] `sessions/{id}/messages` が `seq` 0..N で欠番なく並ぶ
  - [ ] ステージ1・2の回答が `sessions.keep` / `sessions.problem` に入っている
  - [ ] `closing_insight` の assistant メッセージが `generated: false`
  - [ ] assistant メッセージに `latencyMs` / `usage` / `promptVersion` / `model` が入っている
  - [ ] `sessions.model` が `claude-sonnet-5`、`sessions.effort` が `medium` で入っている（`temperature` は無くなった）
  - [ ] `messages.usage` が `inputTokens` / `outputTokens` / `totalTokens` の形になっている
  - [ ] `closingInsight` / `tryPlan` が入り `status: "completed"` になる
  - [ ] **`sessions` ドキュメントにメールアドレスが含まれていない**
- [ ] DevTools の Network で、送信ボディが `{ content, composeMs, memo }` のみ（会話履歴を送っていない）ことを確認

詳細な観点は design.md「検証手順」を参照。

### 2. 統制群を検証する

```
http://localhost:3000/kws
```

- [ ] 一周して、同じ `sessions` コレクションに `condition: "form"` / `stage: null` で保存される
- [ ] design.md に挙げたバグ2件が再発しないこと（コード上は修正済み）
  - Try の二重表示（`finalPlan` と `messages` の両方に描画されていた件）
  - 完了後も入力欄が生きていて送信できてしまう件

### 3. 今回入れた修正を確認する

- [ ] 「中断する」「すべてリセット」を押したセッションが `status: "abandoned"` になり、`abandonedAt` と離脱時点の `stage` が残る
- [ ] 完了後に「新しい振り返りを始める」を押しても `completed` のままで、`abandoned` に落ちない
- [ ] 別の Google アカウントでログインし直しても、前のアカウントの会話が復元されない
- [ ] Firestore コンソールで `sessions` のドキュメントを1件消してから送信 → 「記録が見つかりませんでした」が出て最初からやり直せる（無言で失敗し続けない）
- [ ] AuthGate の打ち切り: DevTools の Network を Offline にして再読み込み → 8秒後に「ログイン状態を確認できませんでした」が出る（無限スピナーにならない）

### 4. ビルドを通す

- [x] `npm run build`（型チェック）
- [x] `npm run lint`
  - Next 16 では `next build` は lint を実行しない。`next lint` は削除済みで、スクリプトは素の `eslint`
  - **コードを触ったら毎回この2つを通すこと**（通っていても実データでの動作は別問題）

---

## 後回し中（意図的）

本番サイトを動かすための作業。ローカル開発には影響しないので、**他人に触ってもらう直前**でよい。

- [ ] Firebase コンソール → Authentication → Settings → 承認済みドメインに Vercel のドメインを追加
  - これを忘れると本番だけ `auth/unauthorized-domain` でログインできない
- [ ] Vercel → Settings → Environment Variables に `.env.local` の内容を全て登録
  - `.env.local` は git に上がらないので手作業。自動同期されない
  - **`GEMINI_API_KEY` / `GEMINI_MODEL` は削除し、`ANTHROPIC_API_KEY` を登録する**（2026-09-09 の移行分）。
    消し忘れても動くが、使っていないキーを本番に置いたままにしない
  - `FIREBASE_PRIVATE_KEY` はダブルクォートなし・`\n` を含んだ1行で貼る
- [ ] **登録後に Redeploy**
  - `NEXT_PUBLIC_*` はビルド時にバンドルへ焼き込まれるため、変数を入れただけでは反映されない
  - コミット `ec37569「環境変数を読み込ませるための強制ビルド」`と同じ罠

**注意:** これらを済ませる前に `main` へ push すると、本番サイトはログイン不可の状態でデプロイされる。ビルド自体は通る（環境変数なしでも落ちない設計）が、AuthGate が「未設定」表示で止まる。

---

## 既知の弱点（今は直さない）

- **送信の連打で `seq` が重複しうる**
  - `startSeq = history.length` を読んでから書くまでの間に別リクエストが入ると同じ番号が振られる
  - WriteBatch は「まとめて書く」だけで、読んだ値が変わっていないことは保証しない（RDB のトランザクションとは別物）
  - 実用上はクライアント側で送信中にボタンを無効化していれば起きない。厳密にやるなら `runTransaction` か、seq をセッションドキュメントのカウンタで採番する

- **ブラウザを閉じただけの離脱は `abandoned` にならない**
  - 「中断する」を押した場合しか記録できない。`beforeunload` での送信は発火が保証されず、`navigator.sendBeacon` は Authorization ヘッダーを付けられない
  - 分析時に「`startedAt` から十分に時間が経った `active`」を離脱とみなす後処理で埋める。**その閾値を論文に明記すること**
  - 予備実験でこの取りこぼしが多いようなら、定期的に生存信号を送る作りに変える

## 次フェーズ（実装しない / 論文と並行して決める）

design.md「論点」節に詳細。決めるべきことだけ再掲:

- 研究デザイン（被験者間 / 被験者内とカウンターバランス）
- **内省の深さの測り方（最優先）** — 評定者2名と κ 係数
  - Kember et al. (2000) は**不採用に決定**（原本が入手できず、本研究の文脈ともずれるため）
  - **代替の枠組みと出典が未確定。** 候補は「上田のリフレクション4分類」。ここが決まらないと `closingInsight` の分析計画が閉じない
  - 統制群フォームの呼称は **KWS に統一済み**
- 主観評価アンケート（SUS 等）を入れるか
- **研究倫理** — 同意画面、学籍番号による個人特定への対応、倫理審査の要否を指導教員に確認
- `status: "abandoned"` を分析に含めるか
- 研究者用エクスポート画面 / SSE ストリーミング
- ~~プロンプト精緻化（`v2.ts`）~~ → **2026-09-09 に実施済み**。[prompt-design.md](./prompt-design.md) 参照
