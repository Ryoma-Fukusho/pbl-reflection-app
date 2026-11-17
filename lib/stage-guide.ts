import type { FacilitatedStage, Stage } from "@/lib/types";

/**
 * 各ステージが質問会議・ALACT モデルのどこにあたり、何が語られたら次へ進んでよいか。
 *
 * 画面（進行表示と「振り返りの進み方」）と、ファシリテーターの両方がこれを使う。
 * goal はファシリテーターが「このステージを終えてよいか」を判定する基準そのもの。
 * 変えると判定と問いが変わるので、lib/prompts の PROMPT_VERSION も上げること。
 *
 * このファイルはブラウザにも読み込まれるので server-only なものを import しないこと。
 */

export type StageGuide = {
  /** 画面とプロンプトで使うステージの呼び名 */
  label: string;
  /** 質問会議の手順と ALACT モデルの局面のどこにあたるか */
  phase: string;
  /** このステージで何をするかの一言。学習者が一人で振り返るときにも使えるように書く */
  description: string;
  /**
   * これが満たされたら次のステージへ進む（ファシリテーターが判断するステージだけ）。
   * ALACT の局面の役割に合わせて書く。第2局面（事実・相手の視点）は振り返って思い出す局面なので
   * 「必要な材料がそろったか」を、第3局面（本当の願い）は気づきの局面なので「本人の解釈として語られたか」を見る。
   * 思い出す局面で気づきまで求めると、答えても答えても先に進まない。
   */
  goal: string;
  /**
   * 初期入力のステージなら true。1回答えたら次へ進み、掘り下げない。
   * 問題を確定させる場ではなく、問題の所在が後のステージで変わるのはかまわない。
   * ここで掘り下げると、後のステージ（事実・相手の視点・本当の願い）で扱う内容と重なり、
   * 評価で比べる「最初の問題」もシステムに形を整えられたものになってしまうため。
   */
  initialInput?: boolean;
};

export const STAGE_GUIDE: Record<Stage, StageGuide> = {
  problem: {
    label: "気になったこと",
    phase: "問題提示 / ALACT 第2局面",
    description: "今日の活動で引っかかっていること、モヤモヤしていることを書き出す",
    goal: "引っかかっていること・モヤモヤしていることが語られた",
    initialInput: true,
  },
  fact: {
    label: "事実",
    phase: "問題の明確化 / ALACT 第2局面(自分の側)",
    description: "その場面で何が起き、自分が何をし、何を考え、どう感じたかを思い出す",
    goal: "その場面で自分が何をした（しなかった）かと、そのとき何を考えたか、またはどう感じたかが、具体的に語られた",
  },
  feeling_other: {
    label: "相手の視点",
    phase: "問題の明確化 / ALACT 第2局面(相手の側)",
    description: "相手の側に立って、相手が何を考え、どう感じ、自分がどう映っていたかを想像する",
    goal: "問題の場面にかかわった相手が何を考え、感じ、望んでいたかが、相手の立場に立った想像として1つ以上語られた。相手の様子の観察だけでは足りない",
  },
  essence: {
    label: "本当の願い",
    phase: "問題の明確化 / ALACT 第3局面",
    description: "自分は本当は何を望んでいたのか、相手の望みとどこがずれていたのかに気づく",
    goal: "本人が本当は何を望んでいたかが、出来事の報告ではなく本人の解釈として語られた",
  },
  closing_insight: {
    label: "問題の言い直し",
    phase: "問題の再定義 / ALACT 第3局面",
    description: "ここまでを通して、あらためていまの問題は何かを自分の言葉で言い直す",
    goal: "",
  },
  action_plan: {
    label: "次に試すこと",
    phase: "アクションプランの提示 / ALACT 第4局面",
    description: "ここまでを踏まえて、次の活動で試してみたいことを自分で決める",
    goal: "",
  },
  try_plan: {
    label: "行動計画",
    phase: "ALACT 第4局面",
    description: "次に試すことを、自分の言葉のまま整理する",
    goal: "",
  },
};

/**
 * 1つのステージで答える回数の上限。これに達したら判断によらず次へ進む。
 *
 * 第2局面（事実・相手の視点）は材料がそろえば足りるので短く、気づきを求める本当の願いだけ長くする。
 * 質問会議でも問題の明確化は時間で区切られている（舘野ら 2015 の表2では20分）。
 */
export const STAGE_TURN_LIMIT: Record<FacilitatedStage, number> = {
  problem: 1,
  fact: 2,
  feeling_other: 2,
  essence: 3,
};

/**
 * この回数に達してもねらいが満たされていなければ、次の問いで「まだ話していないことはあるか」と催促する。
 * いきなり区切ると話の途中で観点が切り替わるため、上限の1つ手前で一度だけ聞く。
 */
export const STAGE_NUDGE_AT: Partial<Record<FacilitatedStage, number>> = {
  essence: 2,
};

/**
 * STEP 2（事実・相手の視点・本当の願い）で答える回数の合計の上限。これに達したら締めの問いへ進む。
 * 利用場面は週ごとの活動の後に一人で使う形なので、対話全体で答える回数を8回程度
 * （問題提示1 + STEP 2 の6 + 締め1、ほかに次に試すこと1）に収める。
 */
export const STEP2_TURN_LIMIT = 6;

/** STEP 2 にあたるステージ。合計の上限を数えるのに使う */
export const STEP2_STAGES: readonly FacilitatedStage[] = ["fact", "feeling_other", "essence"];

/**
 * ステージを終えたか（次へ進むか）の理由。
 *
 * goal_met       ねらいが満たされた
 * saturated      2回続けて、新しく出てくるものが尽きていた
 * limit          そのステージの上限（STAGE_TURN_LIMIT）に達した
 * step_limit     STEP 2 の合計の上限（STEP2_TURN_LIMIT）に達した。締めの問いへ進む
 * initial_input  初期入力のステージ（問題提示）なので1回で進む
 * stay           まだ終えない（nudge: 次の問いで催促する）
 */
export type StageDecision =
  | "goal_met"
  | "saturated"
  | "limit"
  | "step_limit"
  | "initial_input"
  | "stay"
  | "nudge";

/**
 * ステージを終えるかを決める。LLM の判断（goal_met・saturated・flow）を材料にするが、終えるかどうかはこのコードで決める。
 * LLM に終えるかまで決めさせると、回数を数え違えて終えることがあったため。
 *
 * 本人が自分から話を移したターン（learner_shift）では、ねらいが満たされていても終えない。
 * 本人が一番話したいところでシステムが話を閉じてしまうため。ただし上限は優先する。
 * 本当の願いでは、この例外を当てはめない。自分の願いへ話が移ることが、このステージのねらいそのものだから。
 *
 * @param step2Turns STEP 2 で答えた回数の合計（今回の答えを含む）
 * @param previousSaturated このステージの1つ前の判断で、出し切っていたか
 */
export function decideStage(params: {
  stage: FacilitatedStage;
  turnsInStage: number;
  step2Turns: number;
  goalMet: boolean;
  saturated: boolean;
  previousSaturated: boolean;
  flow: string;
}): StageDecision {
  if (STAGE_GUIDE[params.stage].initialInput) return "initial_input";
  if (params.step2Turns >= STEP2_TURN_LIMIT) return "step_limit";
  if (params.turnsInStage >= STAGE_TURN_LIMIT[params.stage]) return "limit";
  if (params.saturated && params.previousSaturated) return "saturated";
  if (params.goalMet && (params.flow !== "learner_shift" || params.stage === "essence")) return "goal_met";
  if (STAGE_NUDGE_AT[params.stage] === params.turnsInStage) return "nudge";
  return "stay";
}

/** その判断で次のステージへ進むか */
export function isStageDone(decision: StageDecision): boolean {
  return decision !== "stay" && decision !== "nudge";
}

