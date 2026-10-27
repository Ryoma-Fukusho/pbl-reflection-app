import "server-only";

import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * Firebase Admin SDK の初期化。
 *
 * このアプリでは Firestore への書き込みを全てサーバー側に集約している。
 * クライアントは Firebase Auth で ID トークンを取得するだけで、Firestore には触らない。
 * そのため、ここで使うサービスアカウント鍵はブラウザに一切露出しない。
 *
 * 初期化を遅延させている理由: モジュールのトップレベルで初期化すると、
 * 環境変数が未設定の環境（CI や、env を入れる前の `next build`）でビルドが落ちる。
 */

type ServiceAccount = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

function readServiceAccount(): ServiceAccount {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  const missing = [
    ["FIREBASE_PROJECT_ID", projectId],
    ["FIREBASE_CLIENT_EMAIL", clientEmail],
    ["FIREBASE_PRIVATE_KEY", privateKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0 || !projectId || !clientEmail || !privateKey) {
    throw new Error(
      `Firebase Admin の環境変数が未設定です: ${missing.join(", ")}。.env.example を参照してください。`
    );
  }

  return {
    projectId,
    clientEmail,
    // .env に書いた秘密鍵の改行は \n という2文字にエスケープされているため、実際の改行に戻す。
    privateKey: privateKey.replace(/\\n/g, "\n"),
  };
}

let cached: { app: App; db: Firestore; auth: Auth } | null = null;

function getAdmin() {
  if (cached) {
    return cached;
  }

  // dev の HMR でモジュールが再評価されても、既存アプリがあれば再利用する。
  // 二重に initializeApp すると "app already exists" で落ちる。
  const app = getApps()[0] ?? initializeApp({ credential: cert(readServiceAccount()) });

  const db = getFirestore(app);
  try {
    // undefined のフィールドを黙って無視する。
    // これを付けないと、任意フィールド（composeMs など）が undefined のときに書き込みが例外になる。
    //
    // settings() は Firestore インスタンスごとに1回しか呼べない。
    // dev の HMR でこのモジュールだけ再評価されると、getFirestore は既存インスタンスを返すため
    // 2回目の呼び出しが例外になる。その場合は既に設定済みなので無視してよい。
    db.settings({ ignoreUndefinedProperties: true });
  } catch {
    // already initialized
  }

  cached = { app, db, auth: getAuth(app) };
  return cached;
}

export function getDb(): Firestore {
  return getAdmin().db;
}

export function getAdminAuth(): Auth {
  return getAdmin().auth;
}
