# Vercel への公開手順

ゼミ内試用や導入実験で、参加者が自分の端末から使えるように、このアプリを Vercel で公開する手順。
環境変数それぞれの中身と、Firebase プロジェクトを最初に作るところは [design.md](./design.md) §5 にある。ここでは、それを Vercel 上で動かすまでの順番を書く。

---

## 全体の流れ

```
GitHub の main ブランチ ──push──▶ Vercel が自動でビルド ──▶ https://<プロジェクト名>.vercel.app
                                        │
                                        ├─ 環境変数（Vercel に登録）を読み込む
                                        └─ ログインは Firebase が「承認済みドメイン」のときだけ通す
```

順番が大事で、**2（環境変数）と 4（Firebase のドメイン）を済ませてから 5（main に反映）** をする。
先に main に反映すると、環境変数のないまま、またはログインできない状態で公開される。

| 手順 | やること | 担当 |
|---|---|---|
| 1 | Vercel にプロジェクトを作る（初回だけ） | 自分 |
| 2 | 環境変数を登録する | 自分 |
| 3 | 関数のリージョンを東京にする（推奨） | 自分 |
| 4 | Firebase の承認済みドメインに Vercel のドメインを足す | 自分 |
| 5 | `facilitator` ブランチを `main` に反映する | Claude に頼める |
| 6 | 公開後に一周して記録を確かめる | 自分 + Claude |

---

## 1. Vercel にプロジェクトを作る（初回だけ）

既存のプロジェクト（`pbl-reflection-app.vercel.app`）を使う場合は、作り直さずに次の2点だけ確かめて手順 2 へ進む。URL が変わらないので、Firebase の承認済みドメインも1つで済む。

- **Settings → Git** で、つながっているリポジトリが `Ryoma-Fukusho/pbl-reflection-app` で、Production Branch が `main` であること
- すでに登録されている環境変数も、今の `.env.local` と見比べて古い値や足りない変数がないこと（手順 2）

新しく作る場合は次のとおり。

1. [vercel.com](https://vercel.com) に GitHub アカウントでログインする
2. **Add New → Project** を押し、`Ryoma-Fukusho/pbl-reflection-app` を **Import** する
3. 設定はほぼそのままでよい
   - Framework Preset: **Next.js**（自動で選ばれる）
   - Root Directory: そのまま（リポジトリ直下）
   - Build Command / Output: そのまま
4. **Deploy** を押す。環境変数がまだないので、この最初のデプロイは失敗するか、動かなくて構わない
5. **Settings → Git** で、Production Branch が `main` になっていることを確かめる

---

## 2. 環境変数を登録する

**Settings → Environment Variables** で、`.env.local` と同じものを1つずつ登録する。
Environments は **Production** にチェックを入れる（試用前にブランチの確認用 URL も使うなら **Preview** にも）。

| 変数 | 入れる値 | 注意 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API キー | **Sensitive** にする |
| `CLAUDE_MODEL` | `claude-sonnet-5` | |
| `CLAUDE_EFFORT` | `medium` | |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Firebase のウェブアプリ設定の値 | 公開されても構わない値 |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | 同上 | |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | 同上 | |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | 同上 | |
| `FIREBASE_PROJECT_ID` | サービスアカウントの値 | |
| `FIREBASE_CLIENT_EMAIL` | 同上 | |
| `FIREBASE_PRIVATE_KEY` | 同上（下の注意を読む） | **Sensitive** にする。本物の秘密 |
| `UNIVERSITY_EMAIL_DOMAINS` | 大学アドレスのドメイン（カンマ区切り） | 任意 |

### `FIREBASE_PRIVATE_KEY` の貼り方

`.env.local` では `"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"` のようにダブルクォートで囲んでいるが、
**Vercel には外側のダブルクォートを付けずに貼る**。中の `\n` はそのまま残す（アプリが読み込むときに改行に戻す）。
クォートごと貼ると、鍵の先頭に `"` が付いてログイン後の処理がすべて失敗する。

### 変数を変えたら再デプロイする

環境変数はデプロイのときに読み込まれる。特に `NEXT_PUBLIC_*` はビルドのときに画面のプログラムに埋め込まれる。
値を足したり変えたりしたら、**Deployments → 最新のデプロイの「…」→ Redeploy** で作り直す。

---

## 3. 関数のリージョンを東京にする（推奨）

Vercel のサーバー側の処理は、初期設定では米国で動く。データベース（Firestore）は東京（`asia-northeast1`）にあるので、
1回の送信のたびに太平洋を何往復もして、応答が遅くなる。

**Settings → Functions** の Region で、**Tokyo（hnd1）** を選ぶ。変えたら再デプロイする。

---

## 4. Firebase の承認済みドメインに Vercel のドメインを足す

Google ログインは、Firebase に登録したドメインからしか通らない。

1. Vercel の **Settings → Domains**（またはプロジェクトの画面）で、公開 URL のドメインを確かめる（例: `pbl-reflection-app.vercel.app`）
2. [Firebase コンソール](https://console.firebase.google.com) → **Authentication → 設定 → 承認済みドメイン** → **ドメインを追加** で、そのドメインを足す（`https://` は付けない）

忘れると、本番だけログインで `auth/unauthorized-domain` になる（手元の `localhost` では動くので気づきにくい）。

---

## 5. `facilitator` ブランチを `main` に反映する

今の作業はすべて `facilitator` ブランチにある。1〜4 が済んだら、`main` に取り込んで GitHub に push する。
Vercel が push を見て自動でビルドし、数分で公開される。

Claude に「main に反映して」と頼めば、取り込みと push まで行う。自分でやる場合は次のとおり。

```bash
git switch main
```

```bash
git merge facilitator
```

```bash
git push origin main
```

Vercel の **Deployments** で、最新のデプロイが **Ready** になれば公開完了。

---

## 6. 公開後に確かめること

公開 URL で一周し、そのあと Firestore の記録を確かめる（記録の読み出しは Claude に頼める）。

- [ ] 公開 URL で Google ログインできる
- [ ] 最初の問いかけが出て、締めの問い・次に試すこと・行動計画まで進める
- [ ] `messages` の `seq` が欠番なく 0, 1, 2, … と並んでいる
- [ ] 締めの問いのメッセージが `generated: false` になっている
- [ ] `sessions` に `promptVersion`・`model`・`effort`・`turnMode` が入っている
- [ ] `sessions.appVersion` がコミットの番号（7文字）になっている。`dev` なら Vercel 以外で動いている
- [ ] `sessions` にメールアドレスが入っていない（`users` にだけある）

`/?debug=1` を付けると判断の中身が見えるが、参加者に配る URL には付けない。

---

## うまくいかないとき

| 症状 | 原因の候補 | 対処 |
|---|---|---|
| ログインはできるが「開始する」で「通信に失敗しました」。ログに `ERR_REQUIRE_ESM`（`jose` … `jwks-rsa`） | Vercel の Node.js が古い。firebase-admin が使う `jose` は ES Module のみで、Node 22.12 以降でないと読み込めない | `package.json` の `engines.node` を `22.x` に固定してある。消さないこと |
| ログインのポップアップがすぐ閉じる / `auth/unauthorized-domain` | 承認済みドメインに Vercel のドメインがない | 手順 4 |
| ログイン画面が出ない、画面が真っ白 | `NEXT_PUBLIC_FIREBASE_*` が無い、または変えたのに再デプロイしていない | 手順 2 のあと Redeploy |
| ログインはできるが「開始する」でエラー | `FIREBASE_*` の値が違う（特に秘密鍵のクォート） | 手順 2 の貼り方を見直して Redeploy |
| 送信するとエラー、または返事が来ない | `ANTHROPIC_API_KEY` が無い・間違い、API の残高切れ | キーと残高を確かめる |
| 返事がとても遅い | 関数が米国で動いている | 手順 3 |
| 環境変数を変えたのに反映されない | 再デプロイしていない | Redeploy |

ビルドや実行時のエラーは、Vercel の **Deployments → 対象のデプロイ → Logs** で見られる。

---

## 費用について

- Vercel は無料の Hobby プランで足りる。Hobby は個人の非商用利用向けのプラン
- 1回の送信あたりの処理は最大60秒で打ち切る設定にしてある（`maxDuration`）。プランの上限を超えると、デプロイ時か実行時にエラーになる
- 費用がかかるのは主に Claude API。参加者が使った分だけ請求される
