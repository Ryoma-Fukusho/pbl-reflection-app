"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type SubmitEvent,
} from "react";

import { Button, FIELD_CLASS } from "@/app/components/ui";

/**
 * 対話の入力欄。
 *
 * 「書き始めてから送信するまでの時間」(composeMs) をここで計測して親に渡す。
 * どれだけ考えてから答えたかの代理指標として、内省の深さの分析に使う。
 *
 * キーボードのある端末では Enter で送信し、Shift + Enter で改行する。
 * 日本語入力の変換を確定する Enter では送信しない（isComposing で見分ける）。
 * スマートフォンなどタッチ操作が主の端末では、画面のキーボードに Shift が無く改行できなくなるので、
 * Enter は改行のままにして送信ボタンで送る。
 */
export default function Composer({
  value,
  onChange,
  onSubmit,
  isLoading,
  placeholder,
  submitLabel,
  loadingLabel = "応答を生成中",
  hint,
  actions,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: (composeMs: number) => void;
  isLoading: boolean;
  placeholder: string;
  submitLabel: string;
  loadingLabel?: string;
  /** 入力欄の下に出す説明。送信の仕方の案内の前に出す */
  hint?: ReactNode;
  /** 中断など、送信ボタンの左に並べる要素 */
  actions?: ReactNode;
}) {
  const composeStartedAtRef = useRef<number | null>(null);
  const [enterSends, setEnterSends] = useState(true);

  useEffect(() => {
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    queueMicrotask(() => setEnterSends(!coarse));
  }, []);

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

  const submit = useCallback(() => {
    if (isLoading || !value.trim()) {
      return;
    }

    const startedAt = composeStartedAtRef.current;
    composeStartedAtRef.current = null;
    onSubmit(startedAt === null ? 0 : Date.now() - startedAt);
  }, [isLoading, value, onSubmit]);

  const handleSubmit = useCallback(
    (event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault();
      submit();
    },
    [submit]
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!enterSends || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
        return;
      }
      event.preventDefault();
      submit();
    },
    [enterSends, submit]
  );

  return (
    <form onSubmit={handleSubmit} className="flex shrink-0 flex-col gap-3">
      <label className="flex flex-col">
        <span className="sr-only">あなたの答え</span>
        <textarea
          value={value}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={`${FIELD_CLASS} min-h-24`}
        />
      </label>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[length:var(--fs-small)] leading-6 text-[var(--text-muted)]">
          {hint ? <>{hint} </> : null}
          {enterSends ? "Enter: 送信 / Shift + Enter: 改行" : null}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          <Button type="submit" disabled={isLoading || !value.trim()}>
            {isLoading ? loadingLabel : submitLabel}
          </Button>
        </div>
      </div>
    </form>
  );
}
