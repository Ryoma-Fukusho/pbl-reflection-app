"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError, useAuth } from "@/app/components/auth-gate";
import ChatLog, { TryPlanCard } from "@/app/components/chat-log";
import Composer from "@/app/components/composer";
import MemoPanel from "@/app/components/memo-panel";
import ReflectionGuide from "@/app/components/reflection-guide";
import SessionReview from "@/app/components/session-review";
import { STAGE_GUIDE } from "@/lib/stage-guide";
import { AppHeader, Button, Notice, Panel, StepRail } from "@/app/components/ui";
import {
  DIALOGUE_STAGES,
  type ChatMessage,
  type CompleteSessionResponse,
  type CreateSessionResponse,
  type PostMessageResponse,
  type ReviewSessionResponse,
  type SessionSummary,
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


/**
 * 開始画面で見せる流れ。初めて使う人向けに、ステージ名ではなく「何をするか」で4つにまとめる。
 * ステージごとの説明は、始めたあと右の「振り返りの進み方」に出る。
 */
const START_STEPS: { title: string; description: string }[] = [
  { title: "気になっていることを書く", description: "今日の活動で引っかかっていること、モヤモヤしていることを書きます。" },
  {
    title: "問いに答えて振り返る",
    description: "そのとき何があったか、相手はどう思っていたか、自分は本当はどうしたかったかを聞かれます。",
  },
  { title: "最初の問題を見直す", description: "最初に書いた問題が、いまどう見えるかを書きます。" },
  { title: "次に試すことを決める", description: "あなたの言葉のまま、次の活動での行動計画にまとめます。" },
];

/** 開始画面の注意書き。共有範囲の書き方は導入実験の事前説明と揃える */
const START_NOTES = [
  "正解はありません。短い答えや「わからない」でもかまいません。",
  "所要時間はおよそ10〜15分で、答えるのは8回前後です。",
  "内容は、プロジェクトにかかわる教員やチームメンバーには共有されません。研究データとして記録し、個人を特定できる情報と切り離して研究者だけが見ます。",
  "途中で気づいたことは、右のメモ欄に自由に書けます。途中でやめるときは「中断する」を押してください。",
];

type Stored = {
  session: SessionSummary;
  messages: ChatMessage[];
  memo: string;
  /** 最後に保存した時刻（ミリ秒）。画面の状態が変わるたびに更新する */
  savedAt: number;
};

/**
 * 下書きを復元する期限。最後の操作からこれより時間が経った下書きは捨てて、最初から始める。
 * 開いたまま閉じた対話が日をまたいで再開されると、1つのセッションの所要時間が数週間と記録され、
 * 1回の振り返りとして分析できなくなるため。サーバー側には active のまま残り、分析では離脱として扱う。
 */
const DRAFT_TTL_MS = 3 * 60 * 60 * 1000;

function readStored(storageKey: string): Stored | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (!parsed.session?.sessionId || !Array.isArray(parsed.messages)) return null;
    if (typeof parsed.savedAt !== "number" || Date.now() - parsed.savedAt > DRAFT_TTL_MS) return null;

    return {
      session: parsed.session,
      messages: parsed.messages,
      memo: typeof parsed.memo === "string" ? parsed.memo : "",
      savedAt: parsed.savedAt,
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
      window.localStorage.setItem(storageKey, JSON.stringify({ session, messages, memo, savedAt: Date.now() } satisfies Stored));
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

  const startSession = useCallback(async () => {
    setError("");
    setIsLoading(true);
    try {
      const data = await postJson<CreateSessionResponse>("/api/sessions", {});
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
    async (composeMs: number) => {
      if (!session || isLoading) return;

      const content = input.trim();
      if (!content) return;

      // 送信中も自分の発言はすぐ見えるようにしておく。サーバーが確定した内容で後から差し替える
      const optimistic: ChatMessage = {
        id: `pending-${Date.now()}`,
        seq: messages.length,
        role: "user",
        content,
        stage: session.stage,
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
      handleApiError(completeError, "行動計画の整理に失敗しました。もう一度押してください。");
    } finally {
      setIsLoading(false);
    }
  }, [session, isLoading, memo, postJson, handleApiError]);

  /** 振り返りの振り返り（任意）を送る。Try の後に出す */
  const submitReview = useCallback(
    async (content: string) => {
      if (!session) return;
      setError("");
      try {
        const data = await postJson<ReviewSessionResponse>(`/api/sessions/${session.sessionId}/review`, { content });
        setSession(data.session);
      } catch (reviewError) {
        handleApiError(reviewError, "送信に失敗しました。");
      }
    },
    [session, postJson, handleApiError]
  );

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

  // 問いを掘り下げるステージ（事実・相手の視点・本当の願い）か
  const isDiggingStage = !!stage && isGeneratedStage(stage);
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
                    今日の活動を、一人で振り返る
                  </h2>
                  <p className="mt-2 text-[length:var(--fs-body)] leading-7 text-[var(--text-secondary)]">
                    AI の問いに答えながら、今日のPBL活動で引っかかっていることを振り返ります。答えは、あなたの言葉のままで大丈夫です。
                  </p>
                </div>

                {/*
                 * 背景に罫の色を敷き、セルの隙間を 1px 空けて表組みに見せている。
                 * カードを並べるより密度が上がり、印刷しても格子が残る。
                 */}
                <ol className="grid gap-px overflow-hidden rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2">
                  {START_STEPS.map((step, index) => (
                    <li key={step.title} className="flex gap-3 bg-[var(--surface-1)] px-4 py-3">
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] text-[length:var(--fs-micro)] font-semibold tabular-nums text-[var(--accent-ink)]">
                        {index + 1}
                      </span>
                      <div>
                        <p className="text-[length:var(--fs-body)] font-semibold text-[var(--text)]">{step.title}</p>
                        <p className="mt-0.5 text-[length:var(--fs-small)] leading-6 text-[var(--text-secondary)]">
                          {step.description}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>

                <ul className="flex flex-col gap-1.5 text-[length:var(--fs-small)] leading-6 text-[var(--text-secondary)]">
                  {START_NOTES.map((note) => (
                    <li key={note} className="flex gap-2">
                      <span aria-hidden className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-[var(--text-muted)]" />
                      {note}
                    </li>
                  ))}
                </ul>

                {error ? <Notice tone="error">{error}</Notice> : null}

                <div className="border-t border-[var(--line)] pt-4">
                  <Button onClick={() => void startSession()} disabled={isLoading || !hydrated}>
                    {isLoading ? "準備しています" : "振り返りを始める"}
                  </Button>
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
                        {isLoading ? "まとめています" : "行動計画をまとめる"}
                      </Button>
                    }
                  >
                    対話はここまでです。答えてくれた「次に試すこと」を、あなたの言葉のまま行動計画にまとめます。
                  </Notice>
                ) : null}

                {isCompleted ? <SessionReview saved={session.sessionReview} onSubmit={submitReview} /> : null}

                {isCompleted ? (
                  <Notice
                    tone="done"
                    action={
                      <Button variant="secondary" onClick={clearWorkspace}>
                        新しい振り返りを始める
                      </Button>
                    }
                  >
                    振り返りが完了しました。おつかれさまでした。記録は保存されています。
                  </Notice>
                ) : null}

                {!isCompleted && !readyForTry ? (
                  <Composer
                    value={input}
                    onChange={setInput}
                    onSubmit={(composeMs) => void sendMessage(composeMs)}
                    isLoading={isLoading}
                    placeholder="思ったことをそのまま書いてください。"
                    submitLabel="送信"
                    hint={
                      isDiggingStage && facilitation?.decision === "nudge" && facilitation.judgedStage === stage
                        ? "この観点は、次の答えで一区切りです。"
                        : "短い答えでも大丈夫です。"
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
              facilitation={facilitation}
              turnsInStage={turnsInStage}
              debug={debug}
            />
          ) : null}
          {session ? (
            <MemoPanel
              value={memo}
              onChange={(next) => {
                setMemo(next);
                setMemoDirty(true);
              }}
              saveState={memoDirty ? "pending" : "saved"}
            />
          ) : null}
        </div>
      </div>
    </main>
  );
}
