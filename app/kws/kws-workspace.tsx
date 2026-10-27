"use client";

import { useCallback, useEffect, useState, type SubmitEvent } from "react";

import { ApiError, useAuth } from "@/app/components/auth-gate";
import ChatLog, { TryPlanCard } from "@/app/components/chat-log";
import Composer from "@/app/components/composer";
import MemoPanel from "@/app/components/memo-panel";
import { AppHeader, Button, Chevron, FIELD_CLASS, Notice, Panel, StepRail } from "@/app/components/ui";
import type {
  ChatMessage,
  CompleteSessionResponse,
  CreateSessionResponse,
  PostMessageResponse,
  SessionSummary,
} from "@/lib/types";

/**
 * KWS フォーム版（統制群 / condition: "form"）。
 *
 * 比較実験の統制条件なので、画面と対話の進み方は従来のまま維持している。
 * 変わったのは、記録が LocalStorage だけでなく Firestore に保存される点。
 * 対話版（/）と同じ sessions コレクションに入るので、同じ粒度で比較できる。
 *
 * 見た目は app/components/ui.tsx の共通部品で対話版と揃える。条件間で画面の
 * 質に差があると、対話形式そのものの効果と切り分けられなくなるため。
 */

/** 下書きの保存先は uid ごとに分ける（理由は dialogue-workspace.tsx の同じ定数を参照）。 */
const STORAGE_PREFIX = "pbl-reflection-workspace:v2";

const STEP_LABELS = ["入力", "対話", "Try"];

type Stored = {
  session: SessionSummary | null;
  messages: ChatMessage[];
  keep: string;
  problem: string;
  memo: string;
};

const emptyStored: Stored = {
  session: null,
  messages: [],
  keep: "",
  problem: "",
  memo: "",
};

function readStored(storageKey: string): Stored {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return emptyStored;

    const parsed = JSON.parse(raw) as Partial<Stored>;
    return {
      session: parsed.session?.sessionId ? parsed.session : null,
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      keep: typeof parsed.keep === "string" ? parsed.keep : "",
      problem: typeof parsed.problem === "string" ? parsed.problem : "",
      memo: typeof parsed.memo === "string" ? parsed.memo : "",
    };
  } catch {
    return emptyStored;
  }
}

export default function KwsWorkspace() {
  const { user, postJson, signOutUser } = useAuth();
  const storageKey = `${STORAGE_PREFIX}:${user.uid}`;

  const [hydrated, setHydrated] = useState(false);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [keep, setKeep] = useState("");
  const [problem, setProblem] = useState("");
  const [memo, setMemo] = useState("");
  const [memoDirty, setMemoDirty] = useState(false);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const stored = readStored(storageKey);
    queueMicrotask(() => {
      setSession(stored.session);
      setMessages(stored.messages);
      setKeep(stored.keep);
      setProblem(stored.problem);
      setMemo(stored.memo);
      setHydrated(true);
    });
  }, [storageKey]);

  // 表示用スナップショット。データの正本は Firestore 側。
  // 1打鍵ごとの書き込みを避けるため少し遅らせて保存する。
  useEffect(() => {
    if (!hydrated) return;

    const timer = window.setTimeout(() => {
      window.localStorage.setItem(
        storageKey,
        JSON.stringify({ session, messages, keep, problem, memo } satisfies Stored)
      );
    }, 400);

    return () => window.clearTimeout(timer);
  }, [hydrated, storageKey, session, messages, keep, problem, memo]);

  /** 画面とローカル下書きを初期状態に戻す。サーバーへの通知は行わない。 */
  const clearWorkspace = useCallback(() => {
    setSession(null);
    setMessages([]);
    setKeep("");
    setProblem("");
    setMemo("");
    setMemoDirty(false);
    setInput("");
    setError("");
    window.localStorage.removeItem(storageKey);
  }, [storageKey]);

  /** サーバーがセッションを知らない場合の復帰（詳細は dialogue-workspace.tsx の同名関数）。 */
  const handleApiError = useCallback(
    (apiError: unknown, fallback: string): void => {
      if (apiError instanceof ApiError && apiError.status === 404) {
        clearWorkspace();
        setError("この振り返りの記録が見つかりませんでした。お手数ですが最初からやり直してください。");
        return;
      }
      setError(apiError instanceof Error ? apiError.message : fallback);
    },
    [clearWorkspace]
  );

  async function startChatSession(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();

    const cleanProblem = problem.trim();
    if (!cleanProblem) {
      setError("問題点・モヤモヤを入力してください。");
      return;
    }

    setError("");
    setIsLoading(true);

    try {
      const data = await postJson<CreateSessionResponse>("/api/sessions", {
        condition: "form",
        keep: keep.trim(),
        problem: cleanProblem,
        memo,
      });

      setSession(data.session);
      setMessages(data.messages);
      setMemoDirty(false);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "AI応答の取得に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  const sendMessage = useCallback(
    async (composeMs: number) => {
      if (!session || isLoading) return;

      const content = input.trim();
      if (!content) return;

      const optimistic: ChatMessage = {
        id: `pending-${Date.now()}`,
        seq: messages.length,
        role: "user",
        content,
        stage: null,
        generated: false,
      };

      setInput("");
      setMessages((current) => [...current, optimistic]);
      setError("");
      setIsLoading(true);

      try {
        const data = await postJson<PostMessageResponse>(
          `/api/sessions/${session.sessionId}/messages`,
          { content, composeMs, memo }
        );

        setMessages((current) => [
          ...current.filter((message) => message.id !== optimistic.id),
          ...data.messages,
        ]);
        setSession(data.session);
        setMemoDirty(false);
      } catch (sendError) {
        setMessages((current) => current.filter((message) => message.id !== optimistic.id));
        setInput(content);
        handleApiError(sendError, "AI応答の取得に失敗しました。");
      } finally {
        setIsLoading(false);
      }
    },
    [session, isLoading, input, messages.length, memo, postJson, handleApiError]
  );

  const generateTryPlan = useCallback(async () => {
    if (!session || isLoading) return;

    setError("");
    setIsLoading(true);
    try {
      const data = await postJson<CompleteSessionResponse>(
        `/api/sessions/${session.sessionId}/complete`,
        { memo }
      );
      setSession(data.session);
      setMessages((current) => [...current, ...data.messages]);
      setMemoDirty(false);
    } catch (finalError) {
      handleApiError(finalError, "Try の生成に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }, [session, isLoading, memo, postJson, handleApiError]);

  /**
   * 「すべてリセット」。未完了のセッションはサーバー側にも離脱として記録する。
   * 記録が失敗しても利用者の操作は止めない。
   */
  const resetWorkspace = useCallback(async () => {
    const current = session;
    clearWorkspace();

    if (current && current.status === "active") {
      await postJson(`/api/sessions/${current.sessionId}/abandon`, {}).catch((abandonError) => {
        console.error("abandon failed", abandonError);
      });
    }
  }, [session, clearWorkspace, postJson]);

  const isCompleted = session?.status === "completed";
  const showTryButton = Boolean(session) && !isCompleted && (session?.turnCount ?? 0) >= 3;
  const stepIndex = !session ? 0 : isCompleted ? 2 : 1;

  // 開始前に画面いっぱいへ引き伸ばさない理由は dialogue-workspace.tsx の同名変数を参照。
  const isStartScreen = !session;

  return (
    <main
      className={`flex min-h-dvh flex-col px-4 py-4 sm:px-6 lg:px-8 lg:py-6 ${
        isStartScreen ? "" : "lg:h-dvh"
      }`}
    >
      <div
        className={`mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 lg:flex-row ${
          isStartScreen ? "lg:items-start" : "lg:min-h-0"
        }`}
      >
        <Panel className="flex-1 overflow-hidden">
          <AppHeader
            onSignOut={() => void signOutUser()}
          >
            <StepRail steps={STEP_LABELS} currentIndex={stepIndex} />
          </AppHeader>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 py-5 sm:px-6">
            {!session ? (
              <form onSubmit={(event) => void startChatSession(event)} className="flex flex-col gap-5">
                <div>
                  <h2 className="text-[length:var(--fs-title)] font-semibold text-[var(--text)]">
                    今日の振り返りを書く
                  </h2>
                  <p className="mt-2 text-[length:var(--fs-body)] leading-7 text-[var(--text-secondary)]">
                    良かったことと気になったことを書いて送信すると、AI がその内容を順に深掘りします。
                  </p>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <Field
                    label="良かったこと（Keep）"
                    value={keep}
                    onChange={setKeep}
                    placeholder="うまくいったこと、続けたいこと。"
                  />
                  <Field
                    label="問題点・モヤモヤ（Problem）"
                    required
                    value={problem}
                    onChange={setProblem}
                    placeholder="困ったこと、引っかかったこと。"
                  />
                </div>

                {error ? <Notice tone="error">{error}</Notice> : null}

                <div className="flex flex-col gap-4 border-t border-[var(--line)] pt-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-[length:var(--fs-small)] leading-6 text-[var(--text-muted)]">
                    所要時間の目安は10〜15分です。
                    <br />
                    入力と対話の内容は研究データとして記録されます。
                  </p>
                  <Button type="submit" disabled={isLoading || !hydrated}>
                    {isLoading ? "準備中" : "振り返りを始める"}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
                <details className="group shrink-0 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)]">
                  <summary className="flex cursor-pointer select-none items-center gap-3 px-4 py-2 text-[length:var(--fs-small)] [&::-webkit-details-marker]:hidden">
                    <span className="shrink-0 font-medium text-[var(--text)]">入力した内容</span>
                    <span className="min-w-0 flex-1 truncate text-[var(--text-muted)] group-open:hidden">
                      {problem || keep || "未入力"}
                    </span>
                    <Chevron className="h-2.5 w-2.5 shrink-0 text-[var(--text-muted)] transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="grid gap-4 border-t border-[var(--line)] px-4 py-3 lg:grid-cols-2">
                    <Recap label="良かったこと（Keep）" value={keep} />
                    <Recap label="問題点・モヤモヤ（Problem）" value={problem} />
                  </div>
                </details>

                <ChatLog
                  // Try は下の専用カードで1回だけ表示するので、ログからは除く
                  messages={messages.filter((message) => message.stage !== "try_plan")}
                  isLoading={isLoading}
                  scrollKey={session.status}
                  footer={isCompleted && session.tryPlan ? <TryPlanCard tryPlan={session.tryPlan} /> : null}
                />

                {error ? <Notice tone="error">{error}</Notice> : null}

                {showTryButton ? (
                  <Notice
                    tone="attention"
                    action={
                      <Button onClick={() => void generateTryPlan()} disabled={isLoading}>
                        {isLoading ? "生成中" : "行動計画（Try）へ進む"}
                      </Button>
                    }
                  >
                    3ターン目に到達しました。深掘りを続けるか、Try に進めます。
                  </Notice>
                ) : null}

                {isCompleted ? (
                  // 完了後は入力欄を閉じる。
                  // 以前は入力欄が残っていて、送信すると Try カードの上に会話が続き
                  // 表示が壊れていた。
                  <Notice
                    tone="done"
                    action={
                      <Button variant="secondary" onClick={clearWorkspace}>
                        新しい振り返りを始める
                      </Button>
                    }
                  >
                    振り返りが完了しました。記録は保存されています。
                  </Notice>
                ) : (
                  <Composer
                    value={input}
                    onChange={setInput}
                    onSubmit={(composeMs) => void sendMessage(composeMs)}
                    isLoading={isLoading}
                    placeholder="気づきや補足を入力して AI に返します。"
                    submitLabel="送信"
                    actions={
                      <Button variant="quiet" onClick={() => void resetWorkspace()}>
                        すべてリセット
                      </Button>
                    }
                  />
                )}
              </div>
            )}
          </div>
        </Panel>

        <MemoPanel
          value={memo}
          onChange={(next) => {
            setMemo(next);
            setMemoDirty(true);
          }}
          saveState={!session ? "idle" : memoDirty ? "pending" : "saved"}
        />
      </div>
    </main>
  );
}

/** Keep / Problem の入力欄。見出しと欄を1組にして両者の扱いを対等に見せる。 */
function Field({
  label,
  value,
  onChange,
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  required?: boolean;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="flex items-baseline gap-2 text-[length:var(--fs-body)] font-medium text-[var(--text)]">
        {label}
        {required ? (
          <span className="text-[length:var(--fs-micro)] font-normal text-[var(--text-muted)]">
            必須
          </span>
        ) : null}
      </span>
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`${FIELD_CLASS} min-h-44`}
      />
    </label>
  );
}

/** 対話中に折りたたんで見返すための、入力内容の控え。 */
function Recap({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[length:var(--fs-micro)] font-medium text-[var(--text-muted)]">{label}</p>
      <p className="mt-1 whitespace-pre-wrap text-[length:var(--fs-body)] leading-7 text-[var(--text)]">
        {value || "未入力"}
      </p>
    </div>
  );
}
