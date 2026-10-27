"use client";

import { onAuthStateChanged, signInWithPopup, signOut, type User } from "firebase/auth";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Button, Panel } from "@/app/components/ui";
import { createGoogleProvider, getClientAuth, isFirebaseConfigured } from "@/lib/firebase/client";

/**
 * API がエラーを返したときの例外。
 *
 * status を持たせているのは、呼び出し側が「やり直せば直るのか、
 * セッションごと作り直すしかないのか」を区別するため。
 * 特に 404（セッションが存在しない）は、画面には会話が残っているのに
 * 何を送っても失敗する状態になるので、専用の復帰処理が要る。
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type AuthValue = {
  user: User;
  /** ID トークンを自動で付けて fetch する。API 呼び出しは必ずこれを通す */
  authedFetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** JSON を POST して結果を受け取る。失敗時は ApiError を投げる */
  postJson: <T>(url: string, body: unknown) => Promise<T>;
  signOutUser: () => Promise<void>;
};

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth は AuthGate の内側でのみ使えます。");
  }
  return value;
}

type Status = "loading" | "signedIn" | "signedOut" | "unconfigured" | "stalled";

/**
 * ログイン状態の確認をここで打ち切る。
 *
 * onAuthStateChanged は「保存済みトークンの復元」が終わってから発火する。
 * この復元は securetoken.googleapis.com への通信と IndexedDB の読み出しを伴うため、
 * 回線が詰まっている・拡張機能に遮られている・IndexedDB が壊れているといった状況では
 * いつまでも発火しないことがある。
 *
 * 打ち切りがないと「ログイン状態を確認しています...」から二度と戻れず、
 * 実験参加者は自力で復帰できない。
 */
const AUTH_RESOLVE_TIMEOUT_MS = 8000;

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <Panel className="w-full max-w-md p-6 sm:p-8">{children}</Panel>
    </main>
  );
}

const CODE_CLASS =
  "rounded-[var(--r-sm)] border border-[var(--line)] bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[length:var(--fs-small)] text-[var(--text)]";

const HEADING_CLASS = "text-[length:var(--fs-title)] font-semibold text-[var(--text)]";
const BODY_CLASS = "mt-3 text-[length:var(--fs-body)] leading-7 text-[var(--text-secondary)]";

export default function AuthGate({ children }: { children: ReactNode }) {
  // NEXT_PUBLIC_* はビルド時にバンドルへ焼き込まれる定数なので、
  // サーバー描画とクライアント描画で必ず同じ値になる。初期 state で判定してよい。
  const [status, setStatus] = useState<Status>(() =>
    isFirebaseConfigured() ? "loading" : "unconfigured"
  );
  const [user, setUser] = useState<User | null>(null);
  const [error, setError] = useState("");
  const [isSigningIn, setIsSigningIn] = useState(false);

  useEffect(() => {
    if (!isFirebaseConfigured()) {
      return;
    }

    const timer = window.setTimeout(() => {
      // 打ち切っても購読は続けたままにする。
      // 遅れて発火したときは下のコールバックが正しい状態に上書きしてくれる。
      setStatus((current) => (current === "loading" ? "stalled" : current));
    }, AUTH_RESOLVE_TIMEOUT_MS);

    const unsubscribe = onAuthStateChanged(
      getClientAuth(),
      (nextUser) => {
        window.clearTimeout(timer);
        setUser(nextUser);
        setStatus(nextUser ? "signedIn" : "signedOut");
      },
      (authError) => {
        window.clearTimeout(timer);
        console.error("onAuthStateChanged failed", authError);
        setStatus("stalled");
      }
    );

    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  const handleSignIn = useCallback(async () => {
    setError("");
    setIsSigningIn(true);
    try {
      await signInWithPopup(getClientAuth(), createGoogleProvider());
    } catch (signInError) {
      const code = (signInError as { code?: string })?.code ?? "";
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
        // 利用者が自分で閉じただけなのでエラー表示はしない
      } else if (code === "auth/popup-blocked") {
        setError("ポップアップがブロックされました。ブラウザの設定で許可してください。");
      } else if (code === "auth/unauthorized-domain") {
        setError(
          "このドメインが Firebase に許可されていません。Authentication → Settings → 承認済みドメイン を確認してください。"
        );
      } else {
        setError("ログインに失敗しました。時間をおいて再度お試しください。");
        console.error("signInWithPopup failed", signInError);
      }
    } finally {
      setIsSigningIn(false);
    }
  }, []);

  const authedFetch = useCallback(async (input: string, init?: RequestInit) => {
    const current = getClientAuth().currentUser;
    if (!current) {
      throw new Error("ログインが必要です。");
    }

    // getIdToken() は期限切れなら自動で更新してくれる
    const token = await current.getIdToken();

    return fetch(input, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
        Authorization: `Bearer ${token}`,
      },
    });
  }, []);

  const postJson = useCallback(
    async <T,>(url: string, body: unknown): Promise<T> => {
      const response = await authedFetch(url, { method: "POST", body: JSON.stringify(body) });
      const data = (await response.json().catch(() => null)) as { error?: unknown } | null;

      if (!response.ok) {
        throw new ApiError(
          typeof data?.error === "string" ? data.error : "通信に失敗しました。",
          response.status
        );
      }
      return data as T;
    },
    [authedFetch]
  );

  const signOutUser = useCallback(async () => {
    await signOut(getClientAuth());
  }, []);

  const value = useMemo<AuthValue | null>(
    () => (user ? { user, authedFetch, postJson, signOutUser } : null),
    [user, authedFetch, postJson, signOutUser]
  );

  if (status === "unconfigured") {
    return (
      <Shell>
        <h1 className={HEADING_CLASS}>Firebase が未設定です</h1>
        <p className={BODY_CLASS}>
          <code className={CODE_CLASS}>.env.local</code> に{" "}
          <code className={CODE_CLASS}>NEXT_PUBLIC_FIREBASE_*</code>{" "}
          を設定し、開発サーバーを再起動してください。設定内容は{" "}
          <code className={CODE_CLASS}>.env.example</code> を参照。
        </p>
      </Shell>
    );
  }

  if (status === "loading") {
    return (
      <Shell>
        <p className="flex items-center gap-2.5 text-[length:var(--fs-body)] text-[var(--text-secondary)]">
          <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-[var(--r-sm)] bg-[var(--warn)]" />
          ログイン状態を確認しています
        </p>
      </Shell>
    );
  }

  if (status === "stalled") {
    return (
      <Shell>
        <h1 className={HEADING_CLASS}>ログイン状態を確認できませんでした</h1>
        <p className={BODY_CLASS}>
          通信が不安定か、ブラウザの設定で Firebase への接続が遮られている可能性があります。
          ページを再読み込みしても直らない場合は、シークレットウィンドウか別のブラウザでお試しください。
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Button className="flex-1" onClick={() => window.location.reload()}>
            再読み込み
          </Button>
          <Button variant="secondary" className="flex-1" onClick={() => setStatus("signedOut")}>
            ログインし直す
          </Button>
        </div>
      </Shell>
    );
  }

  if (status === "signedOut" || !value) {
    return (
      <Shell>
        <h1 className="text-[length:var(--fs-display)] font-semibold tracking-tight text-[var(--text)]">
          振り返りアシスト
        </h1>
        <p className={BODY_CLASS}>
          振り返りの記録は研究データとして保存されます。継続的な振り返りを本人単位で追跡するため、
          Google アカウントでのログインが必要です。大学のアドレス・個人のアドレスどちらでも利用できます。
        </p>

        {error ? (
          <p className="mt-4 rounded-[var(--r-md)] border border-[var(--danger-line)] bg-[var(--danger-soft)] px-4 py-3 text-[length:var(--fs-body)] leading-6 text-[var(--danger)]">
            {error}
          </p>
        ) : null}

        <Button
          className="mt-5 w-full"
          onClick={() => void handleSignIn()}
          disabled={isSigningIn}
        >
          {isSigningIn ? "ログイン中" : "Google でログイン"}
        </Button>
      </Shell>
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
