"use client";

import { CheckMark, Panel } from "@/app/components/ui";
import { STAGE_GUIDE, STAGE_TURN_BUDGET } from "@/lib/stage-guide";
import { DIALOGUE_STAGES, type FacilitationView, type Stage, type TurnMode } from "@/lib/types";

const FLOW_LABELS: Record<string, string> = {
  on_track: "順調",
  learner_shift: "学習者が自分から話を移した",
  drifting: "それている",
  shallow: "浅いまま",
};

const LEVEL_LABELS: Record<string, string> = {
  not_yet: "ねらいにまだ触れていない",
  report: "報告にとどまる",
  insight: "気づきとして語られた",
};

/**
 * 振り返りの進み方。いま扱っている問題と掘っている話、今のステージが ALACT モデルの
 * どこにあたり、何が語られたら次へ進むかを見せる。
 *
 * 学会の質疑で「LLM なしで自分で深掘りする力はつくか」と問われたことを受けて、
 * 進め方そのものを学習者が持ち帰れるように、ステージの流れとねらいを明示している。
 * 判断の中身（話の状態・ねらいへの到達・理由）は学習者には出さず、?debug=1 のときだけ出す。
 */
export default function ReflectionGuide({
  stage,
  turnMode,
  facilitation,
  turnsInStage,
  debug,
}: {
  stage: Stage | null;
  turnMode: TurnMode;
  /** 最後に出た問いの判断。進め方 A と、最初の問いの前は無い */
  facilitation?: FacilitationView;
  /** 今のステージで学習者が話したターン数 */
  turnsInStage: number;
  debug: boolean;
}) {
  const stages: Stage[] = [...DIALOGUE_STAGES];
  // try_plan（対話を終えて Try を整理する段階）では、すべてのステージを済にする
  const currentIndex = stage === "try_plan" ? stages.length : stage ? stages.indexOf(stage) : -1;

  return (
    <Panel className="scroll-slim shrink-0 overflow-y-auto p-5 lg:max-h-[55dvh]">
      <h2 className="border-b border-[var(--line)] pb-3 text-[length:var(--fs-title)] font-semibold text-[var(--text)]">
        振り返りの進み方
      </h2>

      {facilitation?.focus || facilitation?.thread ? (
        <dl className="mt-4 flex flex-col gap-2 rounded-[var(--r-md)] border border-[var(--accent-line)] bg-[var(--accent-soft)] px-3 py-2">
          {facilitation.focus ? (
            <div>
              <dt className="text-[length:var(--fs-micro)] font-medium text-[var(--text-muted)]">いま扱っている問題</dt>
              <dd className="mt-0.5 text-[length:var(--fs-body)] leading-6 text-[var(--text)]">{facilitation.focus}</dd>
            </div>
          ) : null}
          {facilitation.thread ? (
            <div>
              <dt className="text-[length:var(--fs-micro)] font-medium text-[var(--text-muted)]">いま掘っている話</dt>
              <dd className="mt-0.5 text-[length:var(--fs-body)] leading-6 text-[var(--text)]">「{facilitation.thread}」</dd>
            </div>
          ) : null}
        </dl>
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
                  {guide.phase.match(/第\d局面/)?.[0] ?? ""}
                </span>
              </div>

              {isCurrent ? (
                <div className="mt-2 pl-6">
                  <p className="text-[length:var(--fs-micro)] text-[var(--text-muted)]">{guide.phase}</p>
                  <p className="mt-1 text-[length:var(--fs-small)] leading-6 text-[var(--text-secondary)]">
                    {guide.description}
                  </p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      <p className="mt-3 text-[length:var(--fs-micro)] leading-5 text-[var(--text-muted)]">
        流れは質問会議の手順に、問いの観点はALACTモデルの局面に沿っています。第1局面(行為)は今日のPBL活動そのもの、第5局面(試行)は次のPBL活動です。
      </p>

      {debug && turnMode === "flexible" && facilitation && stage && stage in STAGE_TURN_BUDGET ? (
        <div className="mt-4 rounded-[var(--r-md)] border border-dashed border-[var(--line-strong)] px-3 py-2 text-[length:var(--fs-small)] leading-6 text-[var(--text-secondary)]">
          <p className="font-medium text-[var(--text)]">判断(開発用)</p>
          <p>判断したステージ: {STAGE_GUIDE[facilitation.judgedStage].label}</p>
          <p>話の状態: {FLOW_LABELS[facilitation.flow] ?? facilitation.flow}</p>
          <p>ねらい: {LEVEL_LABELS[facilitation.level] ?? facilitation.level}</p>
          <p>ステージを終える: {facilitation.stageDone ? "はい" : "いいえ"}</p>
          <p>
            ターン数: {turnsInStage}(目安 {STAGE_TURN_BUDGET[stage as keyof typeof STAGE_TURN_BUDGET]})
          </p>
          <p>理由: {facilitation.reason}</p>
          <p className="mt-1 text-[var(--text-muted)]">今のステージのねらい: {STAGE_GUIDE[stage].goal}</p>
        </div>
      ) : null}
    </Panel>
  );
}
