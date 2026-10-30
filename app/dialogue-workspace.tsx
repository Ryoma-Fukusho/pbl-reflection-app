"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError, useAuth } from "@/app/components/auth-gate";
import ChatLog, { TryPlanCard } from "@/app/components/chat-log";
import Composer from "@/app/components/composer";
import MemoPanel from "@/app/components/memo-panel";
import ReflectionGuide from "@/app/components/reflection-guide";
import { STAGE_GUIDE } from "@/lib/stage-guide";
import { AppHeader, Button, Notice, Panel, StepRail } from "@/app/components/ui";
import {
  DIALOGUE_STAGES,
  type ChatMessage,
  type CompleteSessionResponse,
  type CreateSessionResponse,
  type PostMessageResponse,
  type SessionSummary,
  type TurnMode,
  isGeneratedStage,
} from "@/lib/types";

/**
 * 下書きの保存先は uid ごとに分ける。
 *
 * 共有 PC で別の人がログインし直したとき、キーが共通だと前の人のセッションが
 * 復元される。画面には会話が出ているのにサーバー側は uid 不一致で弾くため、
 * 何を送っても 404 になって参加者が自力で抜け出せなくなる。
 */
const STORAGE_PREFIX = "pbl-reflection-dialogue:v1";


/** 開始画面で選ぶ進め方。ゼミ内の試用で A と B を比べてもらうため、名前で呼べるようにしている */
const TURN_MODE_OPTIONS: { mode: TurnMode; title: string; description: string }[] = [
  {
    mode: "fixed",
    title: "進め方A: 1問ずつ答える",
    description: "それぞれの問いに1回ずつ答えます。答えると次の問いに進みます。",
  },
  {
    mode: "flexible",
    title: "進め方B: 話に合わせて掘り下げる",
    description: "観点ごとに、話した内容に合わせて問いを重ねます。十分に話せたら次の観点へ進みます。自分で先に進むこともできます。",
  },
];

const TURN_MODE_NAMES: Record<TurnMode, string> = { fixed: "進め方A", flexible: "進め方B" };

type Stored = {
  session: SessionSummary;
  messages: ChatMessage[];
  memo: string;
};

function readStored(storageKey: string): Stored | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (!parsed.session?.sessionId || !Array.isArray(parsed.messages)) return null;

    return {
      // turnMode が無いのは進め方を選べるようになる前の下書き。当時は全て進め方 A
      session: { ...parsed.session, turnMode: parsed.session.turnMode ?? "fixed" },
      messages: parsed.messages,
      memo: typeof parsed.memo === "string" ? parsed.memo : "",
    };
  } catch {
    return null;
  }
}

export default function DialogueWorkspace() {
  const { user, postJson, signOutUser } = useAuth();
  const storageKey = `${STORAGE_PREFIX}:${user.uid}`;

  const [hydrated, setHydrated] = useState(false);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [memo, setMemo] = useState("");
  const [memoDirty, setMemoDirty] = useState(false);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  // ?debug=1 のときだけ、ファシリテーターの判断の中身（話の状態と理由）を出す。テストとデモ用
  const [debug, setDebug] = useState(false);

  useEffect(() => {
    const enabled = new URLSearchParams(window.location.search).get("debug") === "1";
    queueMicrotask(() => setDebug(enabled));
  }, []);

  // 再読み込みで画面が消えないよう、表示用のスナップショットをローカルにも持つ。
  // ただしデータの正本はあくまで Firestore 側。
  useEffect(() => {
    const stored = readStored(storageKey);
    queueMicrotask(() => {
      if (stored) {
        setSession(stored.session);
        setMessages(stored.messages);
        setMemo(stored.memo);
      }
      setHydrated(true);
    });
  }, [storageKey]);

  useEffect(() => {
    if (!hydrated) return;

    if (session) {
      window.localStorage.setItem(storageKey, JSON.stringify({ session, messages, memo }));
    } else {
      window.localStorage.removeItem(storageKey);
    }
  }, [hydrated, storageKey, session, messages, memo]);

  /** 画面とローカル下書きを初期状態に戻す。サーバーへの通知は行わない。 */
  const clearWorkspace = useCallback(() => {
    setSession(null);
    setMessages([]);
    setMemo("");
    setMemoDirty(false);
    setInput("");
    setError("");
    window.localStorage.removeItem(storageKey);
  }, [storageKey]);

  /**
   * サーバーがセッションを知らない場合の復帰。
   *
   * 復元した下書きが古い（別アカウントのもの、あるいは既に消えたもの）と、
   * 会話は画面に見えているのに送信だけが永久に失敗する状態になる。
   * その場合は下書きを捨てて最初からやり直せるようにする。
   */
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

  const startSession = useCallback(async (turnMode: TurnMode) => {
    setError("");
    setIsLoading(true);
    try {
      const data = await postJson<CreateSessionResponse>("/api/sessions", { turnMode });
      setSession(data.session);
      setMessages(data.messages);
      setMemo("");
      setMemoDirty(false);
      setInput("");
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "セッションを開始できませんでした。");
    } finally {
      setIsLoading(false);
    }
  }, [postJson]);

  const sendMessage = useCallback(
    async (composeMs: number, next: boolean) => {
      if (!session || isLoading) return;

      // 空欄で送れるのは、進め方 B の「次の観点へ」と、振り返りの振り返りの「答えずに終える」だけ
      const content = input.trim();
      if (!content && !(next && (session.turnMode === "flexible" || session.stage === "session_review"))) return;

      // 送信中も自分の発言はすぐ見えるようにしておく。
      // サーバーが確定した内容で後から差し替える。空欄で進むときは出さない。
      const optimistic: ChatMessage | null = content
        ? {
            id: `pending-${Date.now()}`,
            seq: messages.length,
            role: "user",
            content,
            stage: session.stage,
            generated: false,
          }
        : null;

      setInput("");
      if (optimistic) {
        setMessages((current) => [...current, optimistic]);
      }
      setError("");
      setIsLoading(true);

      try {
        const data = await postJson<PostMessageResponse>(
          `/api/sessions/${session.sessionId}/messages`,
          { content, composeMs, memo, next }
        );

        setMessages((current) => [
          ...current.filter((message) => message.id !== optimistic?.id),
          ...data.messages,
        ]);
        setSession(data.session);
        setMemoDirty(false);
      } catch (sendError) {
        setMessages((current) => current.filter((message) => message.id !== optimistic?.id));
        setInput(content);
        handleApiError(sendError, "送信に失敗しました。");
      } finally {
        setIsLoading(false);
      }
    },
    [session, isLoading, input, messages.length, memo, postJson, handleApiError]
  );

  const completeSession = useCallback(async () => {
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
    } catch (completeError) {
      handleApiError(completeError, "Try の生成に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }, [session, isLoading, memo, postJson, handleApiError]);

  /**
   * 「中断する」。サーバー側にも離脱として記録してから画面を戻す。
   * 記録が失敗しても利用者の操作は止めない（離脱の記録は分析側の都合なので）。
   */
  const abandonWorkspace = useCallback(async () => {
    const current = session;
    clearWorkspace();

    if (current && current.status === "active") {
      await postJson(`/api/sessions/${current.sessionId}/abandon`, {}).catch((abandonError) => {
        console.error("abandon failed", abandonError);
      });
    }
  }, [session, clearWorkspace, postJson]);

  const stage = session?.stage;
  const isCompleted = session?.status === "completed";
  const readyForTry = session?.status === "active" && stage === "try_plan";
  const currentStageIndex =
    stage && stage !== "try_plan" ? DIALOGUE_STAGES.indexOf(stage) : DIALOGUE_STAGES.length;

  // 進め方 B で「次の観点へ」を出すか。問いを掘り下げるステージ（事実・相手の視点・本当の願い）だけに出す
  const isFlexibleStage = session?.turnMode === "flexible" && !!stage && isGeneratedStage(stage);
  const isSessionReview = stage === "session_review";
  // 最後に出た問いの、ファシリテーターの判断
  const lastQuestion = [...messages].reverse().find((message) => message.role === "assistant");
  const facilitation = lastQuestion?.facilitation;
  const turnsInStage = messages.filter((message) => message.role === "user" && message.stage === stage).length;

  /*
   * 開始前は画面いっぱいに引き伸ばさない。
   * 高さを固定すると説明の下に数百 px の空白が残り、図版にしたときに
   * 紙面の半分が情報ゼロの余白になってしまう。
   */
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
            {session ? (
              <StepRail
                steps={DIALOGUE_STAGES.map((stageName) => STAGE_GUIDE[stageName].label)}
                currentIndex={currentStageIndex}
              />
            ) : null}
          </AppHeader>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 py-5 sm:px-6">
            {!session ? (
              <div className="flex flex-col gap-5">
                <div>
                  <h2 className="text-[length:var(--fs-title)] font-semibold text-[var(--text)]">
                    AI との対話で振り返る
                  </h2>
                  <p className="mt-2 text-[length:var(--fs-body)] leading-7 text-[var(--text-secondary)]">
                    今日の活動について、次の順に問いかけます。
                  </p>
                </div>

                {/*
                 * 背景に罫の色を敷き、セルの隙間を 1px 空けて表組みに見せている。
                 * カードを並べるより密度が上がり、印刷しても格子が残る。
                 */}
                <ol className="grid gap-px overflow-hidden rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2">
                  {DIALOGUE_STAGES.map((stageName, index) => (
                    <li
                      key={stageName}
                      className="flex items-center gap-3 bg-[var(--surface-1)] px-4 py-3 text-[length:var(--fs-body)] text-[var(--text)]"
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--r-sm)] border border-[var(--line-strong)] text-[length:var(--fs-micro)] font-semibold tabular-nums text-[var(--text-secondary)]">
                        {index + 1}
                      </span>
                      {STAGE_GUIDE[stageName].label}
                    </li>
                  ))}
                  <li className="flex items-center gap-3 bg-[var(--accent-soft)] px-4 py-3 text-[length:var(--fs-body)] text-[var(--text)] sm:col-span-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] text-[length:var(--fs-micro)] font-semibold text-[var(--accent-ink)]">
                      {DIALOGUE_STAGES.length + 1}
                    </span>
                    最後に、次に試すことを、あなたの言葉のまま行動計画（Try）として整理します。
                  </li>
                </ol>

                {error ? <Notice tone="error">{error}</Notice> : null}

                <div className="flex flex-col gap-3 border-t border-[var(--line)] pt-4">
                  <p className="text-[length:var(--fs-body)] font-semibold text-[var(--text)]">
                    進め方を選んで始めてください
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {TURN_MODE_OPTIONS.map((option) => (
                      <div
                        key={option.mode}
                        className="flex flex-col gap-3 rounded-[var(--r-md)] border border-[var(--line)] px-4 py-4"
                      >
                        <div>
                          <p className="text-[length:var(--fs-body)] font-semibold text-[var(--text)]">
                            {option.title}
                          </p>
                          <p className="mt-1 text-[length:var(--fs-small)] leading-6 text-[var(--text-secondary)]">
                            {option.description}
                          </p>
                        </div>
                        <Button
                          className="mt-auto"
                          onClick={() => void startSession(option.mode)}
                          disabled={isLoading || !hydrated}
                        >
                          {isLoading ? "準備中" : "この進め方で始める"}
                        </Button>
                      </div>
                    ))}
                  </div>
                  <p className="text-[length:var(--fs-small)] leading-6 text-[var(--text-muted)]">
                    所要時間の目安は10〜15分です。対話の内容は研究データとして記録されます。
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
                <ChatLog
                  // Try は専用カードとして下に1回だけ出すので、ログからは除く
                  messages={messages.filter((message) => message.stage !== "try_plan")}
                  isLoading={isLoading}
                  scrollKey={session.stage}
                  footer={isCompleted && session.tryPlan ? <TryPlanCard tryPlan={session.tryPlan} /> : null}
                />

                {error ? <Notice tone="error">{error}</Notice> : null}

                {readyForTry ? (
                  <Notice
                    tone="attention"
                    action={
                      <Button onClick={() => void completeSession()} disabled={isLoading}>
                        {isLoading ? "整理中" : "行動計画（Try）を整理する"}
                      </Button>
                    }
                  >
                    対話はここまでです。次に試すことを、行動計画として整理します。
                  </Notice>
                ) : null}

                {isCompleted ? (
                  <Notice
                    tone="done"
                    action={
                      <Button variant="secondary" onClick={clearWorkspace}>
                        新しい振り返りを始める
                      </Button>
                    }
                  >
                    振り返りが完了しました({TURN_MODE_NAMES[session.turnMode]})。記録は保存されています。
                  </Notice>
                ) : null}

                {!isCompleted && !readyForTry ? (
                  <Composer
                    value={input}
                    onChange={setInput}
                    onSubmit={(composeMs, next) => void sendMessage(composeMs, next)}
                    isLoading={isLoading}
                    placeholder="思ったことをそのまま書いてください。"
                    submitLabel="送信"
                    nextLabel={isSessionReview ? "答えずに終える" : isFlexibleStage ? "次の観点へ" : undefined}
                    hint={
                      isSessionReview
                        ? "この問いは任意です。"
                        : isFlexibleStage
                          ? "十分に話せたら、次の観点へ進みます。先に進みたいときは「次の観点へ」(空欄でも押せます)。"
                          : undefined
                    }
                    actions={
                      <Button variant="quiet" onClick={() => void abandonWorkspace()}>
                        中断する
                      </Button>
                    }
                  />
                ) : null}
              </div>
            )}
          </div>
        </Panel>

        <div className="flex min-h-0 flex-col gap-4 lg:w-[22rem] xl:w-[24rem]">
          {session ? (
            <ReflectionGuide
              stage={session.stage}
              turnMode={session.turnMode}
              facilitation={facilitation}
              turnsInStage={turnsInStage}
              debug={debug}
            />
          ) : null}
          <MemoPanel
            value={memo}
            onChange={(next) => {
              setMemo(next);
              setMemoDirty(true);
            }}
            saveState={!session ? "idle" : memoDirty ? "pending" : "saved"}
          />
        </div>
      </div>
    </main>
  );
}
