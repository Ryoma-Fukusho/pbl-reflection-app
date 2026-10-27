"use client";

import { useEffect, useRef, type ReactNode } from "react";

import type { ChatMessage } from "@/lib/types";

/**
 * 対話ログの表示。/ (対話版) と /kws (KWS フォーム版) で共用する。
 *
 * 発言者は左右の配置だけでなく「AI／あなた」のラベルでも示している。
 * 論文の図として切り出したとき、吹き出しの向きだけでは誰の発言か読み取れないため。
 */
export default function ChatLog({
  messages,
  isLoading,
  footer,
  scrollKey,
}: {
  messages: ChatMessage[];
  isLoading: boolean;
  /** Try カードなど、ログの末尾に差し込む要素 */
  footer?: ReactNode;
  /** これが変わると最下部へスクロールする */
  scrollKey?: unknown;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isLoading, scrollKey]);

  return (
    <div className="scroll-slim max-h-[60dvh] min-h-0 flex-1 overflow-y-auto rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-2)] p-4 lg:max-h-none">
      <div className="flex flex-col gap-5">
        {messages.map((message) =>
          message.role === "assistant" ? (
            <article key={message.id} className="max-w-[90%] sm:max-w-[78%]">
              <SpeakerLabel>AI</SpeakerLabel>
              <div className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] px-4 py-3 text-[length:var(--fs-lead)] leading-8 text-[var(--text)]">
                <p className="whitespace-pre-wrap">{message.content}</p>
              </div>
            </article>
          ) : (
            <article key={message.id} className="ml-auto max-w-[90%] sm:max-w-[78%]">
              <SpeakerLabel align="right">あなた</SpeakerLabel>
              <div className="rounded-[var(--r-md)] border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-3 text-[length:var(--fs-lead)] leading-8 text-[var(--text)]">
                <p className="whitespace-pre-wrap">{message.content}</p>
              </div>
            </article>
          )
        )}

        {footer}

        {isLoading ? (
          <div className="max-w-[90%] sm:max-w-[78%]">
            <SpeakerLabel>AI</SpeakerLabel>
            <div className="flex items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] px-4 py-4">
              <Dot />
              <Dot delay="150ms" />
              <Dot delay="300ms" />
              <span className="sr-only">応答を生成しています</span>
            </div>
          </div>
        ) : null}

        <div ref={endRef} />
      </div>
    </div>
  );
}

function SpeakerLabel({
  children,
  align = "left",
}: {
  children: ReactNode;
  align?: "left" | "right";
}) {
  return (
    <p
      className={`mb-1.5 text-[length:var(--fs-micro)] font-medium text-[var(--text-muted)] ${
        align === "right" ? "text-right" : ""
      }`}
    >
      {children}
    </p>
  );
}

function Dot({ delay }: { delay?: string }) {
  return (
    <span
      className="h-1.5 w-1.5 animate-bounce rounded-[var(--r-sm)] bg-[var(--text-muted)]"
      style={delay ? { animationDelay: delay } : undefined}
    />
  );
}

/** 対話の結論。ログの中でここだけ左に太い罫を引いて、結果であることを示す。 */
export function TryPlanCard({ tryPlan }: { tryPlan: string }) {
  return (
    <article className="rounded-[var(--r-md)] border border-[var(--ok-line)] border-l-[3px] border-l-[var(--ok)] bg-[var(--ok-soft)] px-4 py-4">
      <h3 className="text-[length:var(--fs-small)] font-semibold text-[var(--ok)]">
        次回の行動計画（Try）
      </h3>
      <div className="mt-2 whitespace-pre-wrap text-[length:var(--fs-lead)] leading-8 text-[var(--text)]">
        {tryPlan}
      </div>
    </article>
  );
}
