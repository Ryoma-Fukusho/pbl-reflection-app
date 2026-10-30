"use client";

import { useCallback, useRef, type ReactNode, type SubmitEvent } from "react";

import { Button, FIELD_CLASS } from "@/app/components/ui";

/**
 * 対話の入力欄。
 *
 * 「書き始めてから送信するまでの時間」(composeMs) をここで計測して親に渡す。
 * どれだけ考えてから答えたかの代理指標として、内省の深さの分析に使う。
 */
export default function Composer({
  value,
  onChange,
  onSubmit,
  isLoading,
  placeholder,
  submitLabel,
  nextLabel,
  loadingLabel = "応答を待っています",
  hint = "Enter は改行です。送信はボタンから。",
  actions,
}: {
  value: string;
  onChange: (next: string) => void;
  /** next は、nextLabel のボタンで送ったら true */
  onSubmit: (composeMs: number, next: boolean) => void;
  isLoading: boolean;
  placeholder: string;
  submitLabel: string;
  /**
   * 指定すると、送信ボタンの左に「次の観点へ」ボタンを出す（進め方 B）。
   * 空欄でも押せ、押すと onSubmit に next: true が渡る
   */
  nextLabel?: string;
  loadingLabel?: string;
  /** 入力欄の下に出す説明 */
  hint?: ReactNode;
  /** リセットや中断など、送信ボタンの左に並べる要素 */
  actions?: ReactNode;
}) {
  const composeStartedAtRef = useRef<number | null>(null);

  const handleChange = useCallback(
    (next: string) => {
      // 空欄から書き始めた瞬間を起点にする
      if (next.length > 0 && composeStartedAtRef.current === null) {
        composeStartedAtRef.current = Date.now();
      }
      if (next.length === 0) {
        composeStartedAtRef.current = null;
      }
      onChange(next);
    },
    [onChange]
  );

  const submit = useCallback(
    (next: boolean) => {
      // 送信は何か書かないと押せない。「次の観点へ」は空欄でも押せる
      if (isLoading || (!value.trim() && !next)) {
        return;
      }

      const startedAt = composeStartedAtRef.current;
      composeStartedAtRef.current = null;
      onSubmit(startedAt === null ? 0 : Date.now() - startedAt, next);
    },
    [isLoading, value, onSubmit]
  );

  const handleSubmit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      submit(false);
    },
    [submit]
  );

  return (
    <form onSubmit={handleSubmit} className="flex shrink-0 flex-col gap-3">
      <label className="flex flex-col">
        <span className="sr-only">対話入力</span>
        <textarea
          value={value}
          onChange={(event) => handleChange(event.target.value)}
          placeholder={placeholder}
          className={`${FIELD_CLASS} min-h-24`}
        />
      </label>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[length:var(--fs-small)] leading-6 text-[var(--text-muted)]">{hint}</p>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {nextLabel ? (
            <Button variant="secondary" onClick={() => submit(true)} disabled={isLoading}>
              {nextLabel}
            </Button>
          ) : null}
          <Button type="submit" disabled={isLoading || !value.trim()}>
            {isLoading ? loadingLabel : submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}
