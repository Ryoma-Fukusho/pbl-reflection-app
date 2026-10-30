# システム設計

PBL の個人の振り返りを、LLM との対話で支援する Web システム「振り返りアシスト」の、**今の**構成をまとめる。
プロンプトの設計は [prompt-design.md](./prompt-design.md)、ここに至る経緯は [history.md](./history.md)、残っている作業は [todo.md](./todo.md)。

---

## 1. 全体の構成

```
ブラウザ ──(Google ログインの ID トークン)──▶ Next.js の Route Handler（Vercel）
                                                 │
                                                 ├─▶ Firebase Auth で ID トークンを検証
                                                 ├─▶ Firestore に読み書き（Admin SDK）
                                                 └─▶ Claude API で問いを生成
```

| 役割 | 使うもの |
|---|---|
| 画面・API | Next.js 16（App Router）。Vercel で動かす（GitHub の `main` に push するとデプロイ） |
| ログイン | Firebase Authentication（Google ログイン。大学・個人どちらのアドレスも可） |
| データ | Cloud Firestore（`asia-northeast1`） |
| LLM | Claude API（既定 `claude-sonnet-5`、effort `medium`） |

### クライアントは Firestore に触らない

- `firestore.rules` は全面 deny。読み書きはすべて Route Handler が Admin SDK で行う
- クライアントが送るのは「今回の1発言」だけ。会話履歴の正本は Firestore にあり、サーバーが読み出して LLM に渡す
- これにより、ブラウザから過去の発言を書き換えて送ることができず、LLM に渡した文脈と DB の記録が一致する
- Admin SDK はルールをバイパスするので、「他人のセッションを触れない」ことは `getOwnedSession`（uid の一致確認）だけが担保している

---

## 2. 画面と API

| パス | 中身 |
|---|---|
| `/` | 対話画面（[app/dialogue-workspace.tsx](../app/dialogue-workspace.tsx)）。`/?debug=1` でファシリテーターの判断の中身も表示する |
| `POST /api/sessions` | セッション開始。開始の問いかけ（固定文言）を1件置いて返す |
| `POST /api/sessions/[id]/messages` | 1ターン分の処理。学習者の発言を保存し、次の問いを生成して返す |
| `POST /api/sessions/[id]/complete` | Try（行動計画）を生成し、セッションを完了にする |
| `POST /api/sessions/[id]/abandon` | 「中断する」を押したときに離脱として記録する |

画面は2列。左が対話、右が「振り返りの進み方」（[reflection-guide.tsx](../app/components/reflection-guide.tsx)）とメモ。

### 対話の進み方

ステージはサーバーが決まった順に進める（[lib/types.ts](../lib/types.ts) の `DIALOGUE_STAGES`）。

| ステージ | 画面の表示 | ALACT モデル | 問い |
|---|---|---|---|
| `keep` | 良かったこと | 第1局面 | 固定文言 |
| `problem` | 気になったこと | 第2局面 | 生成 |
| `fact` | 事実 | 第2局面(自分の側) | 生成 |
| `feeling_other` | 相手の視点 | 第2局面(相手の側) | 生成 |
| `essence` | 本当の願い | 第3局面 | 生成 |
| `closing_insight` | 問題の言い直し | 第3局面 | 固定文言 |
| `try_plan` | 行動計画 | 第4局面 | 生成 |

進め方は開始画面で選ぶ（`sessions.turnMode`）。

- **進め方 A（`fixed`）**: 各ステージで1回答えると次へ進む（計6ターン）
- **進め方 B（`flexible`）**: 学習者は答えるだけ。ステージのねらいが語られたとファシリテーター（LLM）が判断したら次へ進む。学習者は「次の観点へ」（空欄でも押せる）でいつでも先へ進める。ターン数の目安はあるが上限は無い。締めの問いは1回で答える。Problem は初期入力なので1回答えたら進み、掘り下げない（空欄では進めない）

進め方 B では、各ターンでファシリテーターの判断を経て、進むか留まるかと次の問いを決める（[prompt-design.md](./prompt-design.md) §5）。

---

## 3. データモデル

```
users/{uid}
  uid, email, displayName, emailDomain, isUniversityAccount
  createdAt（初回だけ）, lastSeenAt

sessions/{sessionId}
  uid                                  # 個人情報は置かない。users と突合する
  turnMode: "fixed" | "flexible"       # 無いものは "fixed" とみなす
  status: "active" | "completed" | "abandoned"
  stage                                # 今のステージ。完了前は try_plan で止まる
  promptVersion, appVersion, model, effort   # どの条件で集めたデータか
  keep, problem, memo                  # keep/problem はそのステージの回答（B では改行でつないで全部）
  closingInsight                       # 締めの問いへの回答。主な分析対象
  tryPlan
  turnCount, messageCount
  metrics: { totalUserChars, totalAssistantChars, latencySumMs, aiResponseCount, durationMs }
  startedAt, updatedAt, completedAt | abandonedAt

sessions/{sessionId}/messages/{messageId}
  seq                                  # 0,1,2... 並べ替えは必ず seq で
  role: "user" | "assistant", content, charCount, stage, createdAt
  generated                            # assistant: false なら固定文言
  composeMs                            # user: 書き始めてから送信までの時間
  choice: "send" | "next"              # user・進め方 B: 送信か、「次の観点へ」か
  latencyMs, model, promptVersion, finishReason, usage   # assistant: 生成のメタ情報
  facilitation                         # assistant・進め方 B: この問いを出す前の判断（判断したステージ・扱っている問題・掘る話・話の状態・ねらいへの到達・終えるか・理由・ターン数）と、その呼び出しのメタ情報
  skipped                              # assistant: 学習者が空欄で次へ進んだ直後の問いなら true
```

- `seq` を明示的に持つのは、Firestore が挿入順を保証しないため
- 時刻はすべて `serverTimestamp()`。端末の時計のずれで所要時間が汚れないようにする
- `metrics` は平均ではなく合計と件数で持つ。後から別の切り口で集計できるようにするため
- 発話の追記とセッションの更新は WriteBatch で一度に書く。問いは保存されたのにステージが進んでいない、という状態を残さない

---

## 4. 参加者が自分で抜け出せない状態を作らない

| 状況 | 対処 |
|---|---|
| ログイン状態の確認が返ってこない | 8秒で打ち切り、「再読み込み／ログインし直す」を出す。購読は続けるので、遅れて返れば元に戻る |
| 共有 PC で別の人がログインし直した | 画面の下書き（localStorage）を uid ごとに分けている |
| 下書きのセッションがサーバーに無い（404） | 下書きを捨てて最初からやり直せるようにする |
| 途中でやめた | 「中断する」で `abandoned` を書く。ブラウザを閉じただけの離脱は捕まえられないので、分析時に `startedAt` から時間が経った `active` を離脱とみなす（閾値は論文に明記する） |

---

## 5. 環境変数とセットアップ

`.env.local`（git に上げない）と Vercel の Environment Variables の両方に同じ値を入れる。項目は [.env.example](../.env.example)。

| 変数 | 中身 | 注意 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API キー | |
| `CLAUDE_MODEL` / `CLAUDE_EFFORT` | 省略時は `claude-sonnet-5` / `medium` | |
| `NEXT_PUBLIC_FIREBASE_*` | Firebase のウェブアプリ設定 | ブラウザに出る前提の値。ビルド時に焼き込まれるので、変えたら再デプロイが要る |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | サービスアカウントの秘密鍵 | 本物の秘密。`NEXT_PUBLIC_` を付けない。`FIREBASE_PRIVATE_KEY` は `\n` を含んだ1行で貼る |
| `UNIVERSITY_EMAIL_DOMAINS` | 大学アドレスのドメイン（カンマ区切り） | `users.isUniversityAccount` の判定に使う |

### Firebase の準備

1. プロジェクトを作り、Firestore を `asia-northeast1` で作成する（ロケーションは後から変えられない）
2. Authentication で Google ログインを有効にし、承認済みドメインに `localhost` と Vercel のドメインを追加する
3. ウェブアプリを追加して `NEXT_PUBLIC_FIREBASE_*` を、サービスアカウントの秘密鍵を発行して `FIREBASE_*` を取得する（JSON はリポジトリに置かない）
4. Firestore のルールに `firestore.rules` を貼って公開する

---

## 6. 開発

```bash
npm run dev      # http://localhost:3000/ （判断も見るなら /?debug=1）
npm run lint
npm run build    # 型チェックも兼ねる。Next 16 の build は lint を実行しない
node scripts/claude-smoke.mjs   # アプリを起動せずに Claude API の疎通・時間・費用を見る
```

- LLM 呼び出しは [lib/claude.ts](../lib/claude.ts) に閉じ込めている。50秒で打ち切り、Vercel の 60 秒（`maxDuration`）より前に日本語のエラーを返す
- 今のモデルは、assistant で終わる会話（prefill）を 400 で拒否する。会話の組み立て（[lib/conversation.ts](../lib/conversation.ts) の `toTurns`）は必ず user で終わるようにしている

### 既知の弱点

- 送信を連打すると `seq` が重複しうる（履歴の件数を読んでから書くまでの間に別の書き込みが入る場合）。画面側で送信中はボタンを無効にしているので通常は起きない
