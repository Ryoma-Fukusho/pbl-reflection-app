"use client";

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { GoogleAuthProvider, getAuth, type Auth } from "firebase/auth";

/**
 * ブラウザ側の Firebase 初期化。
 *
 * ここで使う値（NEXT_PUBLIC_*）はバンドルに焼き込まれ、ブラウザから丸見えになる。
 * それは正常で、これらは「どの Firebase プロジェクトか」を指す住所にすぎない。
 * 実際の防御は firestore.rules（全面 deny）とサーバー側の ID トークン検証が担う。
 *
 * クライアントが Firebase に対してやることは Google ログインだけで、
 * Firestore には一切触らない。データの読み書きは全て Route Handler 経由。
 */

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId);
}

function getClientApp(): FirebaseApp {
  if (!isFirebaseConfigured()) {
    throw new Error(
      "Firebase のクライアント設定が未定義です。.env.local の NEXT_PUBLIC_FIREBASE_* を確認してください。"
    );
  }

  return getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
}

export function getClientAuth(): Auth {
  return getAuth(getClientApp());
}

export function createGoogleProvider(): GoogleAuthProvider {
  const provider = new GoogleAuthProvider();

  // 毎回アカウント選択画面を出す。
  // 大学アカウントと個人アカウントを併用している利用者が、
  // 意図しない方で黙ってログインされるのを防ぐ。
  provider.setCustomParameters({ prompt: "select_account" });

  return provider;
}
