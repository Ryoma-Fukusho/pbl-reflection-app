"use client";

import { useState } from "react";

import { Button, FIELD_CLASS } from "@/app/components/ui";

/** 振り返りの振り返りの問い。画面の文言として持つ（LLM には渡さない） */
export const SESSION_REVIEW_QUESTION = "今日の問いの中で、考えるきっかけになったものはありましたか？";

/**
 * 振り返りの振り返り（任意）。質問会議の最後の「質問会議の振り返り」にあたる。
 * 対話の流れに入れると終わりに決まった問いが続いて手続きのように感じるので、Try の後に置く。
 */
export default function SessionReview({
  saved,
  onSubmit,
}: {
  /** 送信済みの内容。空なら入力欄を出す */
  saved: string;
  onSubmit: (content: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [isSending, setIsSending] = useState(false);

  return (
    <section className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface-1)] px-4 py-4">
      <h3 className="text-[length:var(--fs-small)] font-semibold text-[var(--text-secondary)]">
        振り返りの振り返り(任意)
      </h3>
      <p className="mt-1 text-[length:var(--fs-body)] leading-7 text-[var(--text)]">{SESSION_REVIEW_QUESTION}</p>

      {saved ? (
        <p className="mt-2 whitespace-pre-wrap text-[length:var(--fs-body)] leading-7 text-[var(--text-secondary)]">
          {saved}
        </p>
      ) : (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const content = value.trim();
            if (!content || isSending) return;
            setIsSending(true);
            void onSubmit(content).finally(() => setIsSending(false));
          }}
        >
          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="なければ書かなくてかまいません。"
            className={`${FIELD_CLASS} min-h-20`}
          />
          <div className="flex justify-end">
            <Button type="submit" variant="secondary" disabled={isSending || !value.trim()}>
              {isSending ? "送信中" : "送る"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
