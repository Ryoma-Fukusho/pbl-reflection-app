import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import type { NextRequest } from "next/server";

import { getAdminAuth, getDb } from "@/lib/firebase/admin";

/**
 * Route Handler 用の認証。
 *
 * クライアントは Firebase Auth で Google ログインし、得た ID トークンを
 * Authorization: Bearer <token> ヘッダーに載せて送ってくる。
 * サーバーはそれを verifyIdToken() で検証する。署名を Google の公開鍵で確かめるので、
 * クライアントが uid を偽装することはできない。
 *
 * 「誰であるか（認証）」はクライアント経由で、
 * 「何を書けるか（権限）」は完全にサーバー側で決まる、という分離になっている。
 */

export type AuthedUser = {
  uid: string;
  email: string | null;
  displayName: string | null;
  emailDomain: string | null;
  isUniversityAccount: boolean;
};

type AuthResult = { ok: true; user: AuthedUser } | { ok: false; response: Response };

function unauthorized(message: string): AuthResult {
  return { ok: false, response: Response.json({ error: message }, { status: 401 }) };
}

function universityDomains(): string[] {
  return (process.env.UNIVERSITY_EMAIL_DOMAINS ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

export async function authenticateRequest(request: NextRequest): Promise<AuthResult> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());

  if (!match) {
    return unauthorized("ログインが必要です。");
  }

  let decoded;
  try {
    decoded = await getAdminAuth().verifyIdToken(match[1]);
  } catch (error) {
    console.error("verifyIdToken failed", error);
    return unauthorized("認証トークンが無効か期限切れです。再度ログインしてください。");
  }

  const email = decoded.email ?? null;

  // Google ログインなら通常 true。念のため確認する。
  if (email && decoded.email_verified === false) {
    return unauthorized("メールアドレスが未確認のアカウントです。");
  }

  const emailDomain = email?.split("@")[1]?.toLowerCase() ?? null;

  return {
    ok: true,
    user: {
      uid: decoded.uid,
      email,
      displayName: decoded.name ?? null,
      emailDomain,
      isUniversityAccount: Boolean(emailDomain && universityDomains().includes(emailDomain)),
    },
  };
}

/**
 * users/{uid} を作成・更新する。
 *
 * 個人情報（メールアドレス・氏名）はこのコレクションにだけ置き、
 * sessions 側には uid しか持たせない。
 * これにより「対話ログ本体には個人情報が含まれない」構造になり、
 * 分析時は研究者が users を引いて突合する形になる。
 *
 * 毎リクエストではなくセッション作成時にだけ呼ぶ（Firestore の書き込み回数を抑えるため）。
 */
export async function upsertUser(user: AuthedUser): Promise<void> {
  const ref = getDb().collection("users").doc(user.uid);

  const profile = {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    emailDomain: user.emailDomain,
    isUniversityAccount: user.isUniversityAccount,
    lastSeenAt: FieldValue.serverTimestamp(),
  };

  // createdAt は初回だけ書く。
  // merge: true で毎回 createdAt を送ると、その都度上書きされて
  // 「いつ研究に参加し始めたか」が失われてしまう。
  const snapshot = await ref.get();

  if (snapshot.exists) {
    await ref.set(profile, { merge: true });
  } else {
    await ref.set({ ...profile, createdAt: FieldValue.serverTimestamp() });
  }
}
