"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type Phase = "entry" | "chat" | "final";
type MessageRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
};

type StoredState = {
  phase: Phase;
  keep: string;
  problem: string;
  memo: string;
  messages: ChatMessage[];
  aiTurnCount: number;
  finalPlan: string;
};

type ChatRequestBody = {
  mode: "turn" | "final";
  turn?: number;
  keep: string;
  problem: string;
  memo: string;
  messages: ChatMessage[];
};

const STORAGE_KEY = "pbl-reflection-workspace:v1";

const defaultState: StoredState = {
  phase: "entry",
  keep: "",
  problem: "",
  memo: "",
  messages: [],
  aiTurnCount: 0,
  finalPlan: "",
};

function createId() {
  return globalThis.crypto?.randomUUID?.() ?? `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isPhase(value: unknown): value is Phase {
  return value === "entry" || value === "chat" || value === "final";
}

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as ChatMessage;
  return (
    typeof candidate.id === "string" &&
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string"
  );
}

function readStoredState(raw: string | null): StoredState {
  if (!raw) {
    return defaultState;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return {
      phase: isPhase(parsed.phase) ? parsed.phase : defaultState.phase,
      keep: typeof parsed.keep === "string" ? parsed.keep : defaultState.keep,
      problem: typeof parsed.problem === "string" ? parsed.problem : defaultState.problem,
      memo: typeof parsed.memo === "string" ? parsed.memo : defaultState.memo,
      messages: Array.isArray(parsed.messages)
        ? parsed.messages.filter(isMessage)
        : defaultState.messages,
      aiTurnCount: typeof parsed.aiTurnCount === "number" ? parsed.aiTurnCount : defaultState.aiTurnCount,
      finalPlan: typeof parsed.finalPlan === "string" ? parsed.finalPlan : defaultState.finalPlan,
    };
  } catch {
    return defaultState;
  }
}

async function postChatPrompt(body: ChatRequestBody) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await response.json().catch(() => null)) as { message?: unknown; error?: unknown } | null;

  if (!response.ok) {
    const errorMessage = typeof data?.error === "string" ? data.error : "AI応答の取得に失敗しました。";
    throw new Error(errorMessage);
  }

  if (typeof data?.message !== "string" || !data.message.trim()) {
    throw new Error("AI応答の形式が不正です。");
  }

  return data.message.trim();
}

export default function ReflectionWorkspace() {
  const [hydrated, setHydrated] = useState(false);
  const [phase, setPhase] = useState<Phase>(defaultState.phase);
  const [keep, setKeep] = useState(defaultState.keep);
  const [problem, setProblem] = useState(defaultState.problem);
  const [memo, setMemo] = useState(defaultState.memo);
  const [messages, setMessages] = useState<ChatMessage[]>(defaultState.messages);
  const [aiTurnCount, setAiTurnCount] = useState(defaultState.aiTurnCount);
  const [finalPlan, setFinalPlan] = useState(defaultState.finalPlan);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messageEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const stored = readStoredState(window.localStorage.getItem(STORAGE_KEY));

    queueMicrotask(() => {
      setPhase(stored.phase);
      setKeep(stored.keep);
      setProblem(stored.problem);
      setMemo(stored.memo);
      setMessages(stored.messages);
      setAiTurnCount(stored.aiTurnCount);
      setFinalPlan(stored.finalPlan);
      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    const snapshot: StoredState = {
      phase,
      keep,
      problem,
      memo,
      messages,
      aiTurnCount,
      finalPlan,
    };

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  }, [hydrated, phase, keep, problem, memo, messages, aiTurnCount, finalPlan]);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, phase, aiTurnCount]);

  const showTryButton = phase === "chat" && aiTurnCount >= 3;
  const stepIndex = phase === "entry" ? 0 : phase === "chat" ? 1 : 2;
  const stepLabels = ["入力", "対話", "Try"];

  function resetWorkspace() {
    setPhase(defaultState.phase);
    setKeep(defaultState.keep);
    setProblem(defaultState.problem);
    setMemo(defaultState.memo);
    setMessages(defaultState.messages);
    setAiTurnCount(defaultState.aiTurnCount);
    setFinalPlan(defaultState.finalPlan);
    setInput("");
    setError("");
    window.localStorage.removeItem(STORAGE_KEY);
  }

  async function startChatSession() {
    const cleanProblem = problem.trim();
    if (!cleanProblem) {
      setError("問題点・モヤモヤを入力してください。");
      return;
    }

    setError("");
    setIsLoading(true);

    const kickoffMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: `Keep: ${keep.trim() || "未入力"}\nProblem: ${cleanProblem}`,
    };

    const nextMessages = [kickoffMessage];
    setPhase("chat");
    setMessages(nextMessages);

    try {
      const reply = await postChatPrompt({
        mode: "turn",
        turn: 1,
        keep: keep.trim(),
        problem: cleanProblem,
        memo,
        messages: nextMessages,
      });

      setMessages([
        ...nextMessages,
        {
          id: createId(),
          role: "assistant",
          content: reply,
        },
      ]);
      setAiTurnCount(1);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "AI応答の取得に失敗しました。");
      setMessages([]);
      setPhase("entry");
    } finally {
      setIsLoading(false);
    }
  }

  async function continueConversation() {
    const cleanInput = input.trim();
    if (!cleanInput || isLoading) {
      return;
    }

    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: cleanInput,
    };

    const nextMessages = [...messages, userMessage];
    const nextTurn = aiTurnCount + 1;

    setInput("");
    setMessages(nextMessages);
    setError("");
    setIsLoading(true);

    try {
      const reply = await postChatPrompt({
        mode: "turn",
        turn: nextTurn,
        keep,
        problem,
        memo,
        messages: nextMessages,
      });

      setMessages([
        ...nextMessages,
        {
          id: createId(),
          role: "assistant",
          content: reply,
        },
      ]);
      setAiTurnCount(nextTurn);
    } catch (conversationError) {
      setError(conversationError instanceof Error ? conversationError.message : "AI応答の取得に失敗しました。");
      setMessages(messages);
    } finally {
      setIsLoading(false);
    }
  }

  async function generateTryPlan() {
    if (!messages.length || isLoading) {
      return;
    }

    setError("");
    setIsLoading(true);

    try {
      const reply = await postChatPrompt({
        mode: "final",
        keep,
        problem,
        memo,
        messages,
      });

      const finalMessage: ChatMessage = {
        id: createId(),
        role: "assistant",
        content: reply,
      };

      setFinalPlan(reply);
      setMessages([...messages, finalMessage]);
      setPhase("final");
    } catch (finalError) {
      setError(finalError instanceof Error ? finalError.message : "Try の生成に失敗しました。");
    } finally {
      setIsLoading(false);
    }
  }

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (phase === "entry") {
      void startChatSession();
      return;
    }

    void continueConversation();
  }

  return (
    <main className="relative flex min-h-dvh flex-col overflow-hidden px-4 py-4 sm:px-6 lg:h-dvh lg:px-8 lg:py-5">
      <div className="pointer-events-none absolute inset-0 opacity-70">
        <div className="absolute left-[-6rem] top-12 h-64 w-64 rounded-full bg-sky-400/20 blur-3xl" />
        <div className="absolute right-0 top-24 h-80 w-80 rounded-full bg-cyan-300/10 blur-3xl" />
      </div>

      <div className="relative mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 lg:min-h-0 lg:flex-row">
        <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[2rem] border border-white/10 bg-[var(--panel)] shadow-2xl shadow-slate-950/30 backdrop-blur-xl">
          <header className="flex flex-col gap-3 border-b border-white/10 px-5 py-4 sm:px-7">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <h1 className="text-lg font-semibold tracking-tight text-white sm:text-xl">
                PBL適応的振り返り支援システム
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                {phase !== "entry" ? (
                  <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">AI turn: {aiTurnCount}</span>
                ) : null}
                <span className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1">
                  <span className={`h-1.5 w-1.5 rounded-full ${hydrated ? "bg-emerald-300" : "animate-pulse bg-amber-300"}`} />
                  {hydrated ? "Saved locally" : "Loading local state..."}
                </span>
              </div>
            </div>

            <ol className="flex flex-wrap items-center gap-2 text-xs">
              {stepLabels.map((label, index) => (
                <li key={label} className="flex items-center gap-2">
                  {index > 0 ? (
                    <span aria-hidden className={`h-px w-5 sm:w-8 ${index <= stepIndex ? "bg-sky-300/50" : "bg-white/15"}`} />
                  ) : null}
                  <span
                    className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium transition ${
                      index === stepIndex
                        ? "border-sky-300/40 bg-sky-400/15 text-sky-100"
                        : index < stepIndex
                          ? "border-emerald-300/25 bg-emerald-400/10 text-emerald-100/90"
                          : "border-white/10 bg-white/5 text-slate-400"
                    }`}
                  >
                    <span className="text-[10px]">{index < stepIndex ? "✓" : index + 1}</span>
                    {label}
                  </span>
                </li>
              ))}
            </ol>

            {phase === "entry" ? (
              <p className="max-w-3xl text-sm leading-6 text-slate-300">
                Keep と Problem を起点に、コルトハーヘン理論に沿って深掘りし、最後に次回の Try を要約します。
              </p>
            ) : null}
          </header>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-5 py-4 sm:px-7 sm:py-5">
            {phase === "entry" ? (
              <form onSubmit={handleFormSubmit} className="scroll-slim flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto">
                <div className="grid gap-5 lg:grid-cols-2">
                  <label className="flex min-h-64 flex-col gap-3 rounded-3xl border border-white/10 bg-white/5 p-4 shadow-inner shadow-black/10 transition focus-within:border-sky-300/40 focus-within:bg-white/[0.07]">
                    <span className="text-sm font-medium text-sky-100">良かったこと（Keep）</span>
                    <textarea
                      value={keep}
                      onChange={(event) => setKeep(event.target.value)}
                      placeholder="うまくいったこと、続けたいことを書きます。"
                      className="min-h-48 flex-1 resize-none rounded-2xl border border-white/10 bg-slate-950/40 px-4 py-3 text-sm leading-6 text-white outline-none transition focus:border-sky-300/60 focus:ring-2 focus:ring-sky-300/15"
                    />
                  </label>
                  <label className="flex min-h-64 flex-col gap-3 rounded-3xl border border-white/10 bg-white/5 p-4 shadow-inner shadow-black/10 transition focus-within:border-sky-300/40 focus-within:bg-white/[0.07]">
                    <span className="text-sm font-medium text-sky-100">問題点・モヤモヤ（Problem）</span>
                    <textarea
                      value={problem}
                      onChange={(event) => setProblem(event.target.value)}
                      placeholder="困ったこと、引っかかったこと、気になったことを書きます。"
                      className="min-h-48 flex-1 resize-none rounded-2xl border border-white/10 bg-slate-950/40 px-4 py-3 text-sm leading-6 text-white outline-none transition focus:border-sky-300/60 focus:ring-2 focus:ring-sky-300/15"
                    />
                  </label>
                </div>

                {error ? (
                  <p className="shrink-0 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</p>
                ) : null}

                <div className="mt-auto flex flex-col gap-3 rounded-3xl border border-white/10 bg-slate-950/30 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-sm leading-6 text-slate-300">
                    送信すると STEP 2 に進み、AI が事実・感情・他者視点を順に深掘りします。
                  </p>
                  <button
                    type="submit"
                    disabled={isLoading}
                    className="inline-flex items-center justify-center rounded-full bg-sky-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isLoading ? "質問を準備中..." : "振り返りを始める"}
                  </button>
                </div>
              </form>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
                <details className="group shrink-0 rounded-2xl border border-white/10 bg-white/5 text-sm text-slate-300">
                  <summary className="flex cursor-pointer select-none items-center gap-3 px-4 py-2.5 [&::-webkit-details-marker]:hidden">
                    <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.2em] text-sky-200/80">Keep / Problem</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-400 group-open:hidden">{problem || keep || "未入力"}</span>
                    <span aria-hidden className="shrink-0 text-[10px] text-slate-400 transition-transform group-open:rotate-180">▼</span>
                  </summary>
                  <div className="grid gap-3 border-t border-white/10 px-4 py-3 lg:grid-cols-2">
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-sky-200/80">Keep</p>
                      <p className="mt-2 whitespace-pre-wrap leading-6 text-white">{keep || "未入力"}</p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-sky-200/80">Problem</p>
                      <p className="mt-2 whitespace-pre-wrap leading-6 text-white">{problem || "未入力"}</p>
                    </div>
                  </div>
                </details>

                <div className="scroll-slim max-h-[60dvh] min-h-0 flex-1 overflow-y-auto rounded-3xl border border-white/10 bg-slate-950/35 p-4 sm:p-5 lg:max-h-none">
                  <div className="flex flex-col gap-4">
                    {messages.map((message) =>
                      message.role === "assistant" ? (
                        <article key={message.id} className="flex max-w-[92%] items-start gap-2.5 sm:max-w-[85%]">
                          <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-sky-300/30 bg-sky-400/15 text-[10px] font-semibold text-sky-200">
                            AI
                          </span>
                          <div className="rounded-2xl rounded-tl-sm border border-sky-300/15 bg-white/[0.06] px-4 py-3 text-sm leading-7 text-sky-50 shadow-lg shadow-slate-950/20">
                            <p className="whitespace-pre-wrap">{message.content}</p>
                          </div>
                        </article>
                      ) : (
                        <article key={message.id} className="ml-auto max-w-[92%] sm:max-w-[85%]">
                          <div className="rounded-2xl rounded-br-sm border border-sky-300/20 bg-sky-400/15 px-4 py-3 text-sm leading-7 text-white shadow-lg shadow-slate-950/20">
                            <p className="whitespace-pre-wrap">{message.content}</p>
                          </div>
                        </article>
                      )
                    )}

                    {phase === "final" ? (
                      <article className="rounded-2xl border border-emerald-300/25 border-l-4 border-l-emerald-300/70 bg-emerald-400/10 p-5 text-sm text-emerald-50">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-200">
                          Final Try Plan
                        </div>
                        <div className="mt-3 whitespace-pre-wrap text-sm leading-7 text-emerald-50/95">
                          {finalPlan}
                        </div>
                      </article>
                    ) : null}

                    {isLoading ? (
                      <div className="flex max-w-[92%] items-start gap-2.5 sm:max-w-[85%]">
                        <span className="mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-sky-300/30 bg-sky-400/15 text-[10px] font-semibold text-sky-200">
                          AI
                        </span>
                        <div className="flex items-center gap-1.5 rounded-2xl rounded-tl-sm border border-sky-300/15 bg-white/[0.06] px-4 py-4">
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-200/80" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-200/80 [animation-delay:150ms]" />
                          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-sky-200/80 [animation-delay:300ms]" />
                        </div>
                      </div>
                    ) : null}
                    <div ref={messageEndRef} />
                  </div>
                </div>

                {error ? (
                  <p className="shrink-0 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</p>
                ) : null}

                {showTryButton ? (
                  <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-50">
                    <p className="leading-6">
                      3ターン目に到達しました。ここで深掘りを続けるか、Try に進めます。
                    </p>
                    <button
                      type="button"
                      onClick={() => void generateTryPlan()}
                      disabled={isLoading}
                      className="rounded-full bg-amber-300 px-4 py-2 font-semibold text-slate-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isLoading ? "Try を生成中..." : "次の行動計画（Try）へ進む"}
                    </button>
                  </div>
                ) : null}

                <form onSubmit={handleFormSubmit} className="flex shrink-0 flex-col gap-2.5 rounded-3xl border border-white/10 bg-slate-950/35 p-3 sm:p-4">
                  <label className="flex flex-col">
                    <span className="sr-only">対話入力</span>
                    <textarea
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      placeholder="気づきや補足を入力して AI に返します。"
                      className="min-h-20 resize-none rounded-2xl border border-white/10 bg-slate-950/40 px-4 py-3 text-sm leading-6 text-white outline-none transition focus:border-sky-300/60 focus:ring-2 focus:ring-sky-300/15"
                    />
                  </label>

                  <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs leading-5 text-slate-500">
                      Enter では送信しません。入力の改行はそのまま保持されます。
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={resetWorkspace}
                        className="rounded-full px-4 py-2 text-sm font-medium text-slate-400 transition hover:bg-white/5 hover:text-slate-100"
                      >
                        すべてリセット
                      </button>
                      <button
                        type="submit"
                        disabled={isLoading || !input.trim()}
                        className="rounded-full bg-sky-400 px-5 py-2 text-sm font-semibold text-slate-950 transition hover:bg-sky-300 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {isLoading ? "AI 応答待ち..." : phase === "final" ? "再度入力" : "送信"}
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            )}
          </div>
        </section>

        <aside className="flex min-h-0 flex-col lg:h-full lg:w-[24rem] xl:w-[26rem]">
          <section className="flex min-h-0 flex-1 flex-col rounded-[2rem] border border-white/10 bg-[var(--panel)] p-5 shadow-2xl shadow-slate-950/30 backdrop-blur-xl">
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-white/10 pb-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.28em] text-sky-200/80">Memo</p>
                <h2 className="mt-1.5 text-lg font-semibold text-white">常設メモ</h2>
              </div>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300">Auto saved</span>
            </div>

            <p className="mt-3 shrink-0 text-xs leading-5 text-slate-400">
              対話中に消えやすい気づきを、ここに即時保存します。Try 生成時にはこのメモも一緒に参照します。
            </p>

            <label className="mt-3 flex min-h-0 flex-1 flex-col">
              <span className="sr-only">メモ欄</span>
              <textarea
                value={memo}
                onChange={(event) => setMemo(event.target.value)}
                placeholder="気づき、アイデア、次に試したいことを書き留めます。"
                className="scroll-slim min-h-[16rem] w-full flex-1 resize-none rounded-2xl border border-white/10 bg-slate-950/40 px-4 py-4 text-sm leading-6 text-white outline-none transition focus:border-sky-300/60 focus:ring-2 focus:ring-sky-300/15 lg:min-h-0"
              />
            </label>

            <div className="mt-3 shrink-0 rounded-2xl border border-white/10 bg-slate-950/30 px-4 py-3 text-xs leading-5 text-slate-400">
              完全非公開。データはブラウザの LocalStorage のみで保持されます。
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}



