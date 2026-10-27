# PBL振り返り支援システム: AI対話化 + Firebase データ収集基盤

> **このドキュメントは 2026-08 時点の設計計画の記録。** 以下はその後の決定で上書きされている。
> - **ルート構成**: 既定の体験は**対話版（`/`）**。KWS フォーム版（統制群）は **`/kws`**。旧 `/session` は `/` へ転送する
> - **用語**: 統制群のフォームの呼称は **KWS** に統一（本文中の「KPT」は旧称）
> - **内省コーディングの枠組み**: Kember et al. (2000) は**使用しない**（下記「論点2」を参照）
> - **プロンプト設計**: [prompt-design.md](./prompt-design.md) が正本（現行は `PROMPT_VERSION = "v2"`）
>
> 本文の実装メモは当時のファイル構成・行番号を指しているため、現在のコードとは一致しない箇所がある。

## Context

卒業研究のシステムを、論文として提出できる水準に引き上げる。現状の課題は3つ。

1. **データが一切残らない** — 全状態が `localStorage` のみ（[reflection-workspace.tsx:33](app/reflection-workspace.tsx#L33)）。研究として最も重要な「収集した対話ログを後から分析する」ができない。
2. **入力形式が静的フォーム** — Keep/Problem を先にテキストエリアで書かせてから対話に入る。これを最初から AI との対話で引き出す形式にしたい。
3. **対話の締めがない** — 深掘りの後すぐ Try 生成に飛ぶ。「今日の対話での気づき／改めて感じた問題」を本人の言葉で言語化させるターンが必要。これは UX 上の締めであると同時に、**研究の主要な測定データ**になる。

今回のゴールは「UI/UX と一連の流れをユーザーが体験でき、その全過程が Firestore に記録される」状態。プロンプトの精緻化は次フェーズ（そのため差し替え可能な構造にしておく）。

### ユーザー決定事項

| 論点 | 決定 |
|---|---|
| 研究デザイン | 既存の KWS フォーム版を統制条件として残し、AI 対話版を新設<br>※ 当初は フォーム版=`/` / 対話版=`/session` としたが、**後に対話版を既定（`/`）、KWS フォーム版を `/kws` に変更**した |
| 参加者識別 | **Google ログイン**（Gmail・大学アドレス両方許可）。大学アドレスは学籍番号から本人追跡可 |
| DB 書き込み経路 | **サーバー経由（Firebase Admin SDK）**。クライアント直書きは全面禁止 |
| 今回のスコープ | **コア体験 + DB 保存のみ**。同意画面・研究者用エクスポート・ストリーミングは次フェーズ |

---

## 設計の要点

### 1. なぜ「サーバー経由」が研究データとして強いか（DB学習メモ）

現状はクライアントが全会話履歴を毎回 POST している（[reflection-workspace.tsx:249-256](app/reflection-workspace.tsx#L249-L256)）。この設計だと、ブラウザの DevTools から履歴を書き換えて送れてしまう。研究データとしては致命的。

新設計では **会話履歴の正本は Firestore にあり、サーバーが読み出す**。クライアントは「今回の1発言」だけを送る。これにより：

- 履歴の改ざんが原理的に不可能になる（論文の「データの信頼性」節に書ける）
- レイテンシ・トークン使用量・使用モデル・プロンプト版といったサーバー側でしか取れない指標を、応答と同一トランザクションで記録できる
- Firestore セキュリティルールは **全面 deny** で済む。Admin SDK はルールをバイパスするので、書き込み口は Route Handler ただ一つになる

```
// firestore.rules — これだけ
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}
```

認証は Google ログインで行うが、**認証と書き込み権限を分離**する点がポイント。クライアントは Firebase Auth で ID トークンを取得するだけで、Firestore には触らない。サーバーが `verifyIdToken()` でトークンを検証してから書く。

### 2. Firestore データモデル

Firestore は「ドキュメント指向」。1ドキュメント最大 1MB、配列に無限に追記する設計は破綻する。**会話メッセージはサブコレクションに切る**のが定石。

```
users/{uid}
  uid, email, displayName, emailDomain,
  isUniversityAccount: boolean,      // 大学ドメインか
  createdAt, lastSeenAt              // serverTimestamp()

sessions/{sessionId}
  uid                                 // ← 個人情報はここに置かない。users を引いて突合
  condition: "form" | "dialogue"      // 統制群 / 実験群
  status: "active" | "completed" | "abandoned"
  stage: Stage | null                 // dialogue のみ。form は null
  startedAt, updatedAt
  completedAt | abandonedAt           // 終わり方で書き分ける。どちらも serverTimestamp()
  promptVersion, appVersion, model, effort        // ← 再現性の要
  keep, problem, memo                 // 最終スナップショット
  closingInsight                      // ★最後の問いへの回答（主要測定データ）
  tryPlan
  turnCount, messageCount
  metrics: {
    totalUserChars, totalAssistantChars, durationMs,
    latencySumMs, aiResponseCount     // 平均ではなく合計と件数で持つ
  }

sessions/{sessionId}/messages/{messageId}
  seq: number                         // 0,1,2... 明示的な順序フィールド
  role: "user" | "assistant"
  content, charCount
  stage: Stage | null
  createdAt
  composeMs?: number                  // user のみ: 書き始めから送信までの時間
  latencyMs?, model?, promptVersion?, finishReason?   // assistant のみ
  usage?: { promptTokens, candidatesTokens, totalTokens }
  generated?: boolean                 // assistant: false = 固定文言（後述）
```

設計上の判断とその理由：

- **`seq` を明示的に持つ** — Firestore は挿入順を保証しない。`createdAt` だけだと同一ミリ秒で順序が壊れる。並べ替えは常に `orderBy("seq")`。
- **`serverTimestamp()` を使う** — クライアント時計は信用できない。研究データでは特に、端末時計のズレが所要時間の測定を汚染する。
- **個人情報を `sessions` に置かない** — `sessions` には `uid` のみ。メールアドレスは `users` にだけ持つ。「ログ本体には個人情報が含まれない」構造は倫理的配慮の節にそのまま書ける。学籍番号の抽出は自動化せず、分析時に研究者が `users` を参照して手動突合する。
- **`promptVersion` / `model` / `effort` を全レコードに刻む** — 次フェーズでプロンプトを改善したとき、どのバージョンで集めたデータか区別できないと分析が破綻する。
- **`metrics` は平均ではなく合計と件数で持つ** — `avgLatencyMs` を保存すると、後から「最初の3ターンだけの平均」のような別の集計ができない。`latencySumMs` と `aiResponseCount` を持っておけば平均は割り算で出せるし、他の切り口にも耐える。生値を残すのが原則。
- **離脱は `abandoned` として明示的に記録する** — 「中断する」「すべてリセット」を押した時点で `POST /api/sessions/{id}/abandon` を呼び、`status` と `abandonedAt` を書く。これがないと離脱セッションが `active` のまま残り、**まだ途中の人と、やめた人の区別がつかなくなる**。離脱時点の `stage` はドキュメントにそのまま残るので、どのステージで離脱が集中するかは後から集計できる（論点6）。<br>ただし**ブラウザを閉じただけの離脱は捕まえられない**（`beforeunload` は発火が保証されない）。その分は「`startedAt` から十分に時間が経った `active`」を分析時に離脱とみなす、という後処理で扱う。
- **リージョンは `asia-northeast1`（東京）** — Firestore のロケーションは**作成後に変更できない**。プロジェクト作成時に必ず指定すること。

必要な複合インデックス: `sessions` を `uid` + `startedAt desc` で引くため1つ。初回クエリ時にコンソールにリンクが出るのでそこから作成。

### 3. 対話ステージ機械（対話版。現在のルートは `/`）

現状の「3ターン経過したら Try ボタンが出る」（[reflection-workspace.tsx:163](app/reflection-workspace.tsx#L163)）を、**サーバー側で駆動する固定ステージ列**に置き換える。全参加者のターン数が揃うので条件間比較が成立する。

コルトハーヘンの ALACT モデルに沿った6ステージ:

| # | Stage | 引き出すもの | 例 |
|---|---|---|---|
| 1 | `keep` | うまくいったこと | 「今日の活動で、うまくいったこと・続けたいと思ったことを聞かせてください」 |
| 2 | `problem` | 引っかかったこと | 「逆に、引っかかったこと・モヤモヤしたことはありましたか」 |
| 3 | `fact` | 行為の想起（事実） | 「その時、具体的にどう動きましたか」 |
| 4 | `feeling_other` | 自分の感情 + 他者視点 | 「その時どう感じましたか。相手からはどう見えていたと思いますか」 |
| 5 | `essence` | 本質的諸相への気づき | 「本当は、どうしたかったのでしょうか」 |
| 6 | `closing_insight` | ★気づきの言語化 | **固定文言**（下記） |
| — | `try_plan` | Try 生成 | AI が全履歴 + メモから生成 |

**ステージ1・2で Keep/Problem を対話から引き出す** — フォーム入力の代替。ユーザー発言を `sessions.keep` / `sessions.problem` にそのまま格納するので、統制群と同じフィールドで比較できる。

**`closing_insight` は AI 生成せず固定文言にする。** 理由：全参加者に一字一句同じ問いを提示したと論文に書けるため。AI に生成させると条件統制が崩れる。DB には `generated: false` で記録し、固定文言であることを明示する。

```
ここまでの対話、ありがとうございました。最後にひとつお聞きします。
今日の対話を通しての気づきや、どんな問題があると改めて思いましたか？
```

ステージ定義とプロンプト本文は `lib/prompts/v1.ts` に配列として一元化する。次フェーズでプロンプトを差し替えるとき、このファイルを `v2.ts` にコピーして `PROMPT_VERSION` を上げるだけで済み、収集済みデータとの対応も保たれる。

### 4. 統制群（KWS フォーム版。現在のルートは `/kws`）の扱い

「ほとんど画面は変わらない」という認識の通り、KWS フォーム版は現状の UI をほぼ維持する。ただし**同じ Firestore スキーマに `condition: "form"` で保存する**。統制群のログが同じ粒度で取れないと比較主張が立たないため、これは実装に含める（差分は小さい — 保存 API を呼ぶだけ）。

統制群では `stage` は `null`、プロンプトは既存の `TURN_1`/`TURN_2`/`TURN_3_PLUS`（[route.ts:34-47](app/api/chat/route.ts#L34-L47)）をそのまま使う。つまり**保存経路は1つ、プロンプト方針が2つ**という構造にする。

### 5. 参加者が自力で復帰できない状態を作らない

実験参加者は開発者ではないので、詰まったときに DevTools を開いて原因を調べることはしない。**画面が固まった時点で、そのデータは失われる。** 予備実験が UI/UX 調査中心である以上、ここは機能の一部として設計する。

具体的に塞いだのは3つ。

**ログイン確認の無限待ち** — `onAuthStateChanged` は保存済みトークンの復元（`securetoken.googleapis.com` への通信 + IndexedDB 読み出し）が終わってから発火する。回線が詰まっている・拡張機能に遮られている・IndexedDB が壊れている、といった状況ではいつまでも発火しない。**8秒で打ち切り**、「再読み込み／ログインし直す」を出す。購読は続けたままにするので、遅れて発火した場合は正しい状態に自動で戻る。

**古い下書きによる詰み** — 表示用スナップショットを localStorage に持っているが、キーが全ユーザー共通だと、共有 PC で別の人がログインした際に前の人のセッションが復元される。サーバーは `getOwnedSession` で uid 不一致を弾くため、**会話は画面に見えているのに送信だけが永久に失敗する**。キーを `...:{uid}` で分け、さらに 404 を受けたら下書きを捨てて最初からやり直せるようにする。

**離脱の記録** — 上記2つと違い参加者側の問題ではないが、「中断する」を押されたときに `abandoned` を書かないと、UI/UX 上どこで諦められたのかが残らない。予備実験の主目的そのものなので必ず記録する。

---

## 実装

### 依存追加

```
npm install firebase firebase-admin
```

### 環境変数（`.env.local` に追記 + `.env.example` を新規作成）

```bash
# Claude API（2026-09-09 に Gemini から移行）
ANTHROPIC_API_KEY=
CLAUDE_MODEL=      # 任意。未設定なら claude-sonnet-5
CLAUDE_EFFORT=     # 任意。未設定なら medium

# Firebase クライアント（ブラウザに露出する。公開前提の値なので問題ない）
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=

# Firebase Admin（サーバー専用。絶対に NEXT_PUBLIC_ を付けない）
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

# 大学ドメイン判定用（カンマ区切り）
UNIVERSITY_EMAIL_DOMAINS=
```

`NEXT_PUBLIC_*` は **`next build` 時にバンドルへ焼き込まれる**（`environment-variables.md:166`）。Vercel では環境変数を設定した後に必ず再デプロイが要る — 過去のコミット `ec37569 環境変数を読み込ませるための強制ビルド` と同じ罠。

`FIREBASE_PRIVATE_KEY` は改行がエスケープされるので、読み込み時に `.replace(/\\n/g, "\n")` が必要。

### 新規ファイル

| ファイル | 役割 |
|---|---|
| `lib/types.ts` | `Stage`, `Condition`, `SessionDoc`, `MessageDoc`, API リクエスト/レスポンス型を集約。**現状 `ChatMessage` が client と server で別々に定義されている**（[reflection-workspace.tsx:8](app/reflection-workspace.tsx#L8) と [route.ts:9](app/api/chat/route.ts#L9)、前者だけ `id` を持つ）ので、ここに統合する。`@/*` エイリアスが tsconfig に定義済みで未使用なので活用する |
| `lib/firebase/admin.ts` | Admin SDK 初期化。`getApps()[0] ?? initializeApp(...)` で dev の HMR による二重初期化を防ぐ。`getFirestore()` をエクスポート |
| `lib/firebase/client.ts` | Client SDK 初期化 + `GoogleAuthProvider`。ブラウザ専用 |
| `lib/auth.ts` | `Authorization: Bearer <idToken>` を検証し `{ uid, email }` を返す Route Handler 用ヘルパー。`users/{uid}` の upsert もここで |
| `lib/prompts/v1.ts` | `PROMPT_VERSION = "v1"`、ステージ定義配列、固定文言、既存の `COMMON_SYSTEM`/`TURN_*`/`FINAL_SYSTEM` を移設 |
| `lib/claude.ts` | Claude 呼び出しラッパ（公式 SDK `@anthropic-ai/sdk`）。API キーは SDK が `ANTHROPIC_API_KEY` から読み、ヘッダーで送るのでクエリ文字列に残らない。レイテンシ計測とトークン数（`usage`）の抽出、SDK の例外を日本語メッセージに変換する `ClaudeError` を含む。<br>当初は `lib/gemini.ts` として Gemini REST を直接叩いていた（2026-09-09 に移行、旧ファイルは削除） |
| `lib/repository.ts` | Firestore の読み書き。`createSession` / `appendMessages` / `getMessages` / `getOwnedSession` / `completionPatch` / `abandonSession`。**`getOwnedSession` で uid の一致を必ず確認する** — Admin SDK はルールをバイパスするので、他人のログを読ませない保証はこの関数だけが担っている |
| `lib/conversation.ts` | Firestore の履歴を Claude に渡す形へ組み立てる層。`generateStageQuestion`（実験群）/ `generateFormReply`（統制群）/ `generateTryPlan`（共通）。プロンプト定義と Claude 呼び出しの間に挟むことで、条件ごとの分岐をここ1箇所に閉じ込める |
| `lib/route-utils.ts` | Route Handler 共通のエラー応答（`badRequest` / `notFound` / `conflict` / `errorResponse`）とリクエスト読み取り。スタックトレースをクライアントに漏らさないための境界 |
| `app/api/sessions/route.ts` | `POST` — セッション作成。`condition` を受け、dialogue なら開始メッセージを返す |
| `app/api/sessions/[sessionId]/messages/route.ts` | `POST` — 1ターン処理の中核。`{ content, composeMs, memo }` を受け、履歴は **Firestore から読む** |
| `app/api/sessions/[sessionId]/complete/route.ts` | `POST` — Try 生成 + `status: "completed"` 化 |
| `app/api/sessions/[sessionId]/abandon/route.ts` | `POST` — 途中離脱の記録。`status: "abandoned"` 化。既に完了済みのセッションは落とさない |
| `app/session/page.tsx` | `/session` ルート |
| `app/session/dialogue-workspace.tsx` | AI 対話版クライアントコンポーネント |
| `app/components/auth-gate.tsx` | `onAuthStateChanged` を監視し、未ログインなら Google ログインボタンを表示。既存のダークグラスモーフィズム調に合わせる。API 呼び出し用の `postJson`（ID トークン自動付与 + `ApiError`）もここから配る |
| `app/components/chat-log.tsx` / `memo-panel.tsx` / `composer.tsx` | `/` と `/session` で共用する UI を抽出。既存のスタイル文字列（[reflection-workspace.tsx:434-480](app/reflection-workspace.tsx#L434-L480), [540-568](app/reflection-workspace.tsx#L540-L568)）をそのまま移す |
| `firestore.rules` | 全面 deny |

Next 16 注意点: 動的セグメントの `params` は **await 必須**。型は自動生成される `RouteContext` ヘルパーを使う。

```ts
export async function POST(req: NextRequest, ctx: RouteContext<'/api/sessions/[sessionId]/messages'>) {
  const { sessionId } = await ctx.params
```

新規 Route Handler にも既存と同じ `runtime = "nodejs"` / `maxDuration = 60` を付ける。`firebase-admin` は Edge ランタイムでは動かないので `nodejs` は必須。

### 既存ファイルの変更

**`app/reflection-workspace.tsx`（統制群）** — UI は維持しつつ:
- `AuthGate` でラップし、ログイン必須にする
- 「振り返りを始める」で `POST /api/sessions`（`condition: "form"`）を呼び、以降は新エンドポイントを使う
- localStorage 保存は下書き復帰用として残すが、**正本は Firestore**。「LocalStorage のみで保持されます」という文言（[reflection-workspace.tsx:565](app/reflection-workspace.tsx#L565)）を実態に合わせて修正する
- バグ修正2件（統制条件が正しく動作しないと実験が成立しないため必須）:
  - Try が二重表示される — `generateTryPlan()` が `setFinalPlan()` と `setMessages([...])` の両方を行い、JSX が両方描画している（[L298-L299](app/reflection-workspace.tsx#L298-L299) と [L455-L464](app/reflection-workspace.tsx#L455-L464)）
  - `final` 到達後も入力欄が生きており、送信すると `continueConversation()` が走るが `phase` は `final` のまま — Try カードが上に残り続ける（[L316](app/reflection-workspace.tsx#L316), [L530](app/reflection-workspace.tsx#L530)）
- localStorage 書き込みの debounce — 現状メモの1打鍵ごとに全体を再シリアライズしている（[L157](app/reflection-workspace.tsx#L157)）

**`app/api/chat/route.ts`** — プロンプト定数を `lib/prompts/v1.ts` へ、LLM 呼び出しを `lib/gemini.ts`（現 `lib/claude.ts`）へ移した上で、このファイル自体は削除（新エンドポイントに統合）。

---

## Firebase 側のセットアップ（ユーザーが手作業で行う部分）

### 前提: 3つのサービスの役割分担

```
GitHub          Vercel                    Firebase
(コード置き場)   (アプリが動く場所)         (データ置き場 + ログイン)
   │                │                          │
   └── push で連携 ─┘                          │
                    └──── HTTP で呼ぶだけ ─────┘
                          (環境変数で接続)
```

**GitHub と Firebase を接続する設定は不要。** Firebase は「アプリの一部」ではなく外部サービスであり、コードから見れば Claude API を呼ぶのと同じ — 住所（プロジェクトID）と鍵を持って HTTP で呼ぶだけ。繋ぐのは「コード ↔ Firebase」で、その接続方法が環境変数。

Firebase にも GitHub 連携機能（Firebase Hosting / App Hosting に GitHub リポジトリを繋いで自動ビルドする機能）は存在するが、それは **Firebase 上でアプリをホスティングする場合**の話。今回は Vercel でホスティングし、Firebase は Firestore と Auth だけ使うため使わない。

### 設定する場所は3箇所

| # | 場所 | やること | git に上がる？ |
|---|---|---|---|
| A | Firebase コンソール（ブラウザ） | プロジェクト作成 / Firestore 作成 / Google ログイン有効化 / 鍵の発行 | — |
| B | `.env.local`（手元のPC） | A で取得した値を貼る。ローカル開発用 | ❌ `.gitignore` 済み |
| C | Vercel ダッシュボード<br>Settings → Environment Variables | B と同じ値を登録。本番用 | — |

B は git に上がらないので、**C は手作業でもう一度入れる必要がある**。自動同期されない。

### 2種類の「鍵」— 性質が正反対なので混同しないこと

**1. ウェブアプリ設定（`NEXT_PUBLIC_FIREBASE_*`）**
「どの Firebase プロジェクトか」を指す**住所**。ブラウザに丸見えになるが、それが正常であり秘密ではない。第三者がこれを知っても、セキュリティルールが全面 deny なので何もできない — 守るのはルール側の仕事。

**2. サービスアカウント秘密鍵（`FIREBASE_PRIVATE_KEY` / `FIREBASE_CLIENT_EMAIL`）**
こちらは**本物の秘密**。持っていれば全データを読み書きできる。

- 絶対に `NEXT_PUBLIC_` を付けない（付けるとバンドルに焼き込まれて全世界に公開される）
- 絶対に git にコミットしない
- サーバー側（Route Handler）でのみ使う

「サーバー経由で書く」設計を選んだのは、この鍵をサーバーに閉じ込められるため。

### プロジェクトはいくつ作るか

**まず1つでよい。** 卒研規模なら開発と本番を分けなくても回る。厳密にやるなら開発用・本番用の2つを作りテストデータの混入を防ぐが、管理コストが倍になる。**1つで作り始め、実際に学生に使ってもらう直前に本番用を分ける**のが現実的。環境変数を差し替えるだけで対応できる構造にしてある。

### 手順

1. https://console.firebase.google.com でプロジェクトを新規作成（Google Analytics は不要）
2. 構築 → Firestore Database → データベースを作成
   - **ロケーションは `asia-northeast1`（東京）。作成後に変更できない**ので必ず確認する
   - モードは「本番環境モード」（どのみち手順7で全面 deny のルールに差し替える）
3. 構築 → Authentication → 始める → Sign-in method → **Google を有効化**
4. Authentication → Settings → 承認済みドメイン に `localhost` と Vercel のドメインを追加
5. プロジェクト設定（⚙）→ 全般 → 一番下「マイアプリ」→ ウェブアプリ（`</>`）を追加
   → 表示される `firebaseConfig` から `apiKey` / `authDomain` / `projectId` / `appId` を `.env.local` の `NEXT_PUBLIC_FIREBASE_*` へ
6. プロジェクト設定 → **サービスアカウント** → 「新しい秘密鍵の生成」→ JSON がダウンロードされる
   → JSON 内の `project_id` / `client_email` / `private_key` を `.env.local` の `FIREBASE_*` へ
   → **JSON ファイル自体はリポジトリに置かない**（ダウンロードフォルダから動かさないか、削除する）
7. Firestore Database → ルール タブに `firestore.rules` の内容を貼り付けて「公開」
8. Vercel の Environment Variables に、`.env.local` と同じ内容を全て登録 → 再デプロイ

`NEXT_PUBLIC_*` は **`next build` 時にバンドルへ焼き込まれる**（`environment-variables.md:166`）ため、Vercel では環境変数を設定した後に必ず再デプロイが要る — 過去のコミット `ec37569 環境変数を読み込ませるための強制ビルド` と同じ罠。

`FIREBASE_PRIVATE_KEY` は改行を含むため `.env.local` ではダブルクォートで囲み、コード側で `.replace(/\\n/g, "\n")` して復元する。

### Google ログインのドメイン制限について

`provider.setCustomParameters({ hd: "..." })` は**アカウント選択画面のヒントにすぎず、強制力はない**（このパラメータを外したリクエストを送れば回避できる）。今回は Gmail と大学アドレスの両方を許可する方針なので制限自体はかけず、サーバー側で検証済みトークンの `email` からドメインを判定し `isUniversityAccount` フラグを立てるだけにする。

---

## 実装の進め方（段階を分けて、都度動作確認する）

DB を学びながら進めたいという意図があるため、一気に作らず4段階に分けて各段階で動作を確認する。

| 段階 | 内容 | ここで確認できること |
|---|---|---|
| **1. 疎通確認** | Firebase プロジェクト作成（上記手順1〜7）＋ `lib/firebase/admin.ts` ＋ 動作確認用の一時的な Route Handler で1件書き込む | 環境変数が正しいか、Firestore に書けるか。**ここが通らないと先に進んでも原因の切り分けができない** |
| **2. 認証** | `lib/firebase/client.ts` ＋ `AuthGate` ＋ `lib/auth.ts` | Google ログインが通り、サーバー側で `verifyIdToken()` が成功し `users/{uid}` ができるか |
| **3. データ層** | `lib/types.ts` / `lib/repository.ts` / `lib/prompts/v1.ts` / `lib/claude.ts` ＋ 3つの Route Handler | 対話1往復で `sessions` と `messages` が正しい形で積まれるか（この時点では UI は既存のままでもよい） |
| **4. UI** | 対話版の対話画面 ＋ 共通コンポーネント抽出 ＋ `/` の統制群対応とバグ修正 | 一連の体験が通しで成立するか |

段階1が終わった時点で一時的な確認用ルートは削除する。

## 検証手順

1. `npm run dev` → `http://localhost:3000/`（対話版。KWS フォーム版は `/kws`）
2. 未ログイン状態で AuthGate が出ること、Google ログインが通ること
3. 対話を6ステージ最後まで一周する
   - ステージ1・2の回答が `sessions/{id}` の `keep` / `problem` に入っているか
   - ステージ6で**固定文言**が出ること（AI 生成の揺らぎがないこと。2回試して同一文言を確認）
   - 回答が `closingInsight` に入るか
   - Try が `tryPlan` に入り `status: "completed"` になるか
4. Firebase コンソールの Firestore で確認:
   - `sessions/{id}/messages` が `seq` 0..N で欠番なく並ぶ
   - assistant メッセージに `latencyMs` / `usage` / `promptVersion` / `model` が入っている
   - `closing_insight` の assistant メッセージが `generated: false`
   - `sessions` ドキュメントにメールアドレスが**含まれていない**こと
5. `/`（統制群）を一周し、同じ `sessions` コレクションに `condition: "form"` / `stage: null` で保存されること
6. DevTools の Network で、クライアントが会話履歴全体を送っていないこと（`{ content, composeMs, memo }` のみ）を確認
7. `npm run build`（型チェック）と `npm run lint` を通す
   - Next 16 では `next build` は lint を実行しない。`next lint` は削除済みで、スクリプトは素の `eslint`

---

## 論点（設計判断が必要だが今回は実装しない事項）

論文化に向けて、実装と並行して決めておくべきこと。

**1. 主張の型と統計処理**
比較主張にするなら、被験者間（学生をランダムに2群に割付）か被験者内（同一学生が両方を体験）かを決める必要がある。被験者内は個人差を統制できるが**順序効果**が出る（先に AI 対話を体験すると、後のフォーム記入でも深く書いてしまう）。カウンターバランスが必要。卒研の参加者数（おそらく10〜30名）では被験者内の方が検出力が出やすい。

**2. 内省の深さをどう測るか**
これが論文の核心。`closingInsight` がコーディングの主対象になる。評定者2名でコーディングし κ 係数（評定者間一致度）を報告するのが定石。

**枠組みは未確定。** 当初挙げていた Kember et al. (2000) の4段階コーディングは、**原本が入手できず、本研究の文脈ともずれるため使用しない方針**。候補として「上田のリフレクション4分類」が挙がっているが、出典を確定させたうえで採否を決めること。
補助指標として実装済みのメトリクスが使える: 発話文字数の推移、`composeMs`（考えている時間）、ターンあたりの情報量。

**3. 主観評価アンケート**
SUS（システム使用性）や独自の内省実感尺度を対話後に取ると、客観指標と主観指標の両面から論じられる。`sessions` に `survey` フィールドを足すだけなので、次フェーズで安価に追加できる。

**4. 研究倫理（実験実施前に必須）**
今回スコープ外だが、実際に学生からデータを集める前に必要になる:
- 同意画面（研究目的・データ利用範囲・撤回方法の明示と同意記録）
- 大学アドレスのローカルパートが学籍番号なら**個人が特定できる**。所属機関の倫理審査が要るかを指導教員に確認すること
- データ削除要求への対応手順

**5. LLM の非決定性**
応答は決まらない。しかも Claude API への移行（2026-09-09）で `temperature` が使えなくなったため、Gemini 版のように「低温度で揺らぎを抑えている」という説明も取れない（Claude Sonnet 5 / Opus 5 では temperature・top_p が廃止され、送ると 400 で弾かれる）。同一入力に対する応答分散を報告するか、そもそも「AI の応答内容」ではなく「対話プロセスがもたらす内省」を主張の対象に絞るか。後者の方が論文として守りやすい。

**6. 途中離脱セッションの扱い**
`status: "abandoned"` のデータを分析に含めるか除外するかを事前に決め、論文に明記する。どのステージで離脱が多いかは、それ自体がシステム評価の知見になる。

**7. 次フェーズの実装候補**
- 研究者用エクスポート画面（JSON/CSV 一括ダウンロード）— 分析作業が劇的に楽になる
- SSE ストリーミング — `maxDuration = 60` は現状の band-aid。ストリーミングにすれば根本解決し、体感速度も改善する
- プロンプト精緻化 — `lib/prompts/v2.ts` として追加し `PROMPT_VERSION` を上げる
