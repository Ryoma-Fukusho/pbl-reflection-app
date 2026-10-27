"use client";

import { CheckMark, Panel } from "@/app/components/ui";
import { STAGE_GUIDE, isItemCovered } from "@/lib/stage-guide";
import { DIALOGUE_STAGES, type FacilitationView, type Stage, type TurnMode } from "@/lib/types";

const FLOW_LABELS: Record<string, string> = {
  on_track: "順調",
  learner_shift: "学習者が自分から話を移した",
  drifting: "それている",
  shallow: "浅いまま",
};

/**
 * 振り返りの進み方。いま扱っている問題と、今のステージが ALACT モデルのどこにあたり、
 * 何が聞けて何を聞いているかを見せる。
 *
 * 学会の質疑で「LLM なしで自分で深掘りする力はつくか」と問われたことを受けて、
 * 進め方そのものを学習者が持ち帰れるように、ステージの流れと観点を明示している。
 * 判断の中身（話の状態と理由）は学習者には出さず、?debug=1 のときだけ出す。
 */
export default function ReflectionGuide({
  stage,
  turnMode,
  facilitation,
  debug,
}: {
  stage: Stage | null;
  turnMode: TurnMode;
  /** 今のステージで最後に出た問いの判断。進め方 A と、ステージに入る前は無い */
  facilitation?: FacilitationView;
  debug: boolean;
}) {
  const stages: Stage[] = [...DIALOGUE_STAGES, "try_plan"];
  const currentIndex = stage ? stages.indexOf(stage) : -1;

  return (
    <Panel className="scroll-slim shrink-0 overflow-y-auto p-5 lg:max-h-[55dvh]">
      <h2 className="border-b border-[var(--line)] pb-3 text-[length:var(--fs-title)] font-semibold text-[var(--text)]">
        振り返りの進み方
      </h2>

      {facilitation?.focus ? (
        <div className="mt-4 rounded-[var(--r-md)] border border-[var(--accent-line)] bg-[var(--accent-soft)] px-3 py-2">
          <p className="text-[length:var(--fs-micro)] font-medium text-[var(--text-muted)]">いま扱っている問題</p>
          <p className="mt-1 text-[length:var(--fs-body)] leading-6 text-[var(--text)]">{facilitation.focus}</p>
        </div>
      ) : null}

      <ol className="mt-4 flex flex-col gap-2">
        {stages.map((name, index) => {
          const guide = STAGE_GUIDE[name];
          const isCurrent = index === currentIndex;
          const isDone = index < currentIndex;

          return (
            <li
              key={name}
              aria-current={isCurrent ? "step" : undefined}
              className={`rounded-[var(--r-md)] border px-3 py-2 ${
                isCurrent ? "border-[var(--accent)] bg-[var(--surface-1)]" : "border-[var(--line)] bg-[var(--surface-2)]"
              }`}
            >
              <div className="flex items-baseline gap-2">
                <span
                  className={`flex h-4 w-4 shrink-0 items-center justify-center self-center rounded-[var(--r-sm)] text-[length:var(--fs-micro)] font-semibold tabular-nums ${
                    isCurrent
                      ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                      : isDone
                        ? "bg-[var(--text)] text-[var(--surface-1)]"
                        : "border border-[var(--line-strong)] text-[var(--text-muted)]"
                  }`}
                >
                  {isDone ? <CheckMark /> : index + 1}
                </span>
                <span
                  className={`text-[length:var(--fs-body)] ${
                    isCurrent ? "font-semibold text-[var(--text)]" : "text-[var(--text-secondary)]"
                  }`}
                >
                  {guide.label}
                </span>
                <span className="ml-auto shrink-0 text-[length:var(--fs-micro)] text-[var(--text-muted)]">
                  {guide.phase.split(" ")[0]}
                </span>
              </div>

              {isCurrent ? (
                <div className="mt-2 pl-6">
                  <p className="text-[length:var(--fs-micro)] text-[var(--text-muted)]">ALACTモデル {guide.phase}</p>
                  <p className="mt-1 text-[length:var(--fs-small)] leading-6 text-[var(--text-secondary)]">
                    {guide.description}
                  </p>
                  {guide.items.length > 0 ? (
                    <ul className="mt-2 flex flex-col gap-1">
                      {guide.items.map((item) => (
                        <StageItem
                          key={item}
                          item={item}
                          // 進め方 A では判断が無いので、観点を並べるだけにする
                          state={
                            turnMode !== "flexible" || !facilitation
                              ? "plain"
                              : isItemCovered(item, facilitation.covered)
                                ? "covered"
                                : facilitation.nextItem && isItemCovered(item, [facilitation.nextItem])
                                  ? "asking"
                                  : "open"
                          }
                        />
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      {debug && facilitation ? (
        <div className="mt-4 rounded-[var(--r-md)] border border-dashed border-[var(--line-strong)] px-3 py-2 text-[length:var(--fs-small)] leading-6 text-[var(--text-secondary)]">
          <p className="font-medium text-[var(--text)]">判断(開発用)</p>
          <p>話の状態: {FLOW_LABELS[facilitation.flow] ?? facilitation.flow}</p>
          <p>だいたい聞けた: {facilitation.stageDone ? "はい" : "いいえ"}</p>
          <p>理由: {facilitation.reason}</p>
        </div>
      ) : null}
    </Panel>
  );
}

function StageItem({ item, state }: { item: string; state: "plain" | "covered" | "asking" | "open" }) {
  return (
    <li className="flex items-start gap-2 text-[length:var(--fs-small)] leading-6">
      <span
        aria-hidden
        className={`mt-1.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[var(--r-sm)] ${
          state === "covered"
            ? "bg-[var(--ok)] text-[var(--surface-1)]"
            : state === "asking"
              ? "border border-[var(--accent)] bg-[var(--accent-soft)]"
              : "border border-[var(--line-strong)]"
        }`}
      >
        {state === "covered" ? <CheckMark className="h-2 w-2" /> : null}
      </span>
      <span
        className={
          state === "covered"
            ? "text-[var(--text-secondary)]"
            : state === "asking"
              ? "font-semibold text-[var(--accent)]"
              : "text-[var(--text-secondary)]"
        }
      >
        {item}
        {state === "asking" ? <span className="ml-1 font-normal">← いま聞いていること</span> : null}
        <span className="sr-only">{state === "covered" ? "(聞けた)" : ""}</span>
      </span>
    </li>
  );
}
