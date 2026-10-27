"use client";

import { FIELD_CLASS, Panel } from "@/app/components/ui";

/**
 * 常設メモ。対話中に消えやすい気づきを書き留めておく欄。
 * Try 生成時にこの内容も一緒に AI へ渡される。
 */
export default function MemoPanel({
  value,
  onChange,
  saveState,
}: {
  value: string;
  onChange: (next: string) => void;
  /** 保存状態の表示。未保存なら "pending" */
  saveState: "idle" | "pending" | "saved";
}) {
  const label =
    saveState === "pending" ? "未保存" : saveState === "saved" ? "保存済み" : "自動保存";

  return (
    <aside className="flex min-h-0 flex-1 flex-col">
      <Panel className="flex-1 p-5">
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-[var(--line)] pb-3">
          <h2 className="text-[length:var(--fs-title)] font-semibold text-[var(--text)]">メモ</h2>
          <span className="flex items-center gap-1.5 text-[length:var(--fs-small)] text-[var(--text-muted)]">
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-[var(--r-sm)] ${
                saveState === "pending" ? "bg-[var(--warn)]" : "bg-[var(--ok)]"
              }`}
            />
            {label}
          </span>
        </div>

        <label className="mt-4 flex min-h-0 flex-1 flex-col">
          <span className="sr-only">メモ欄</span>
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="気づいたこと、次に試したいこと。"
            className={`${FIELD_CLASS} scroll-slim min-h-64 flex-1 lg:min-h-0`}
          />
        </label>

        <p className="mt-3 shrink-0 text-[length:var(--fs-small)] leading-6 text-[var(--text-muted)]">
          メモは発言を送信したときにサーバーへ保存されます。
        </p>
      </Panel>
    </aside>
  );
}
