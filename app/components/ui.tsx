/**
 * 画面の共通部品。枠・ヘッダ・進行表示・通知・ボタン・入力欄の見た目をここに集約する。
 */

import type { ReactNode } from "react";

/* ------------------------------------------------------------------ 記号 */

/** 完了印。テキストの ✓ はフォント依存で字面が変わるので描画する。 */
export function CheckMark({ className = "h-2.5 w-2.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 10 10" fill="none" aria-hidden>
      <path
        d="M1.5 5.2 3.9 7.5 8.5 2.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="square"
      />
    </svg>
  );
}


/* ------------------------------------------------------------------ 枠 */

/** 主要な面。影ではなく罫で輪郭を作る（縮小・モノクロ印刷でも輪郭が残る）。 */
export function Panel({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={`flex min-h-0 flex-col rounded-[var(--r-lg)] border border-[var(--line)] bg-[var(--surface-1)] ${className}`}
    >
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ ヘッダ */

/**
 * 画面上端の帯。
 *
 * 論文に画面を載せるため、ログイン中のアドレスは出さない。
 */
export function AppHeader({
  onSignOut,
  children,
}: {
  onSignOut: () => void;
  /** 見出しの下に置く進行表示など */
  children?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 flex-col gap-4 border-b border-[var(--line)] px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h1 className="text-[length:var(--fs-display)] font-semibold tracking-tight text-[var(--text)]">
          振り返りアシスト
        </h1>

        <div className="flex items-center gap-3 text-[length:var(--fs-small)]">
          <button
            type="button"
            onClick={onSignOut}
            className="text-[var(--text-muted)] underline decoration-[var(--line-strong)] underline-offset-4 transition hover:text-[var(--text)] hover:decoration-[var(--text)]"
            data-print-hide
          >
            ログアウト
          </button>
        </div>
      </div>

      {children}
    </header>
  );
}

/* ------------------------------------------------------------------ 進行表示 */

/**
 * 進行状況。
 *
 * 済 / 現在 / 未 を「塗りの濃さ」で分けている（ほぼ黒 / 中間 / 白抜き）。
 * 色相だけで区別すると、モノクロ印刷したときに3状態が同じ灰色に潰れる。
 */
export function StepRail({ steps, currentIndex }: { steps: string[]; currentIndex: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-y-2">
      {steps.map((label, index) => {
        const isDone = index < currentIndex;
        const isCurrent = index === currentIndex;

        return (
          <li key={label} className="flex items-center">
            {index > 0 ? (
              <span
                aria-hidden
                className={`mx-2 h-px w-3 sm:w-4 ${
                  index <= currentIndex ? "bg-[var(--line-strong)]" : "bg-[var(--line)]"
                }`}
              />
            ) : null}

            <span
              aria-current={isCurrent ? "step" : undefined}
              className={`flex items-center gap-1.5 rounded-[var(--r-sm)] border px-2 py-1 text-[length:var(--fs-micro)] ${
                isCurrent
                  ? "border-[var(--accent)] bg-[var(--accent-soft)] font-semibold text-[var(--accent)]"
                  : isDone
                    ? "border-[var(--line)] bg-[var(--surface-3)] text-[var(--text-secondary)]"
                    : "border-[var(--line)] bg-[var(--surface-1)] text-[var(--text-muted)]"
              }`}
            >
              <span
                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[var(--r-sm)] text-[length:var(--fs-micro)] font-semibold tabular-nums ${
                  isCurrent
                    ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                    : isDone
                      ? "bg-[var(--text)] text-[var(--surface-1)]"
                      : "border border-[var(--line-strong)] text-[var(--text-muted)]"
                }`}
              >
                {isDone ? <CheckMark /> : index + 1}
              </span>
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* ------------------------------------------------------------------ 通知 */

type NoticeTone = "error" | "attention" | "done";

const NOTICE_TONES: Record<NoticeTone, string> = {
  error: "border-[var(--danger-line)] bg-[var(--danger-soft)] text-[var(--danger)]",
  attention: "border-[var(--warn-line)] bg-[var(--warn-soft)] text-[var(--warn)]",
  done: "border-[var(--ok-line)] bg-[var(--ok-soft)] text-[var(--ok)]",
};

/** 文面と、あれば次の操作を1本の帯にまとめる。 */
export function Notice({
  tone,
  children,
  action,
}: {
  tone: NoticeTone;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className={`flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-[var(--r-md)] border px-4 py-3 text-[length:var(--fs-body)] ${NOTICE_TONES[tone]}`}
    >
      <p className="leading-6">{children}</p>
      {action}
    </div>
  );
}

/* ------------------------------------------------------------------ ボタン */

const BUTTON_VARIANTS = {
  primary:
    "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)] hover:border-[#164aa8] hover:bg-[#164aa8]",
  secondary:
    "border-[var(--line-strong)] bg-[var(--surface-1)] text-[var(--text)] hover:bg-[var(--surface-2)]",
  quiet:
    "border-transparent bg-transparent text-[var(--text-muted)] hover:border-[var(--line)] hover:text-[var(--text)]",
} as const;

export function Button({
  variant = "primary",
  type = "button",
  disabled,
  onClick,
  className = "",
  children,
}: {
  variant?: keyof typeof BUTTON_VARIANTS;
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex items-center justify-center rounded-[var(--r-md)] border px-4 py-2 text-[length:var(--fs-body)] font-medium transition disabled:cursor-not-allowed disabled:opacity-45 ${BUTTON_VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ 入力欄 */

/** 対話入力とメモで共通の見た目にする。 */
export const FIELD_CLASS =
  "w-full resize-none rounded-[var(--r-md)] border border-[var(--line-strong)] bg-[var(--surface-1)] px-3 py-3 text-[length:var(--fs-body)] leading-7 text-[var(--text)] outline-none transition placeholder:text-[var(--text-muted)] focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)]";
