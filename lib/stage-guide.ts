import type { FacilitatedStage, Stage } from "@/lib/types";

/**
 * 各ステージが質問会議・ALACT モデルのどこにあたり、何が語られたら次へ進んでよいか。
 *
 * 画面（進行表示と「振り返りの進み方」）と、進め方 B のファシリテーターの両方がこれを使う。
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
  /** 進め方 B で、これが語られたら次のステージへ進む（ファシリテーターが判断するステージだけ） */
  goal: string;
  /**
   * 初期入力のステージなら true。進め方 B でも1回答えたら次へ進み、掘り下げない。
   * 問題を確定させる場ではなく、問題の所在が後のステージで変わるのはかまわない。
   * ここで掘り下げると、後のステージ（事実・相手の視点・本当の願い）で扱う内容と重なり、
   * 評価で比べる「最初の問題」もシステムに形を整えられたものになってしまうため。
   */
  initialInput?: boolean;
  /** 答えずに次へ進めないステージなら true */
  answerRequired?: boolean;
};

export const STAGE_GUIDE: Record<Stage, StageGuide> = {
  problem: {
    label: "気になったこと",
    phase: "問題提示 / ALACT 第2局面",
    description: "今日の活動で引っかかっていること、モヤモヤしていることを書き出す",
    goal: "引っかかっていること・モヤモヤしていることが語られた",
    initialInput: true,
    answerRequired: true,
  },
  fact: {
    label: "事実",
    phase: "問題の明確化 / ALACT 第2局面(自分の側)",
    description: "その場面で何が起き、自分が何をし、何を考え、どう感じたかを思い出す",
    goal: "その場面で自分が何をした（しなかった）か、何を考え、どう感じたかが、本人の言葉で語られた",
  },
  feeling_other: {
    label: "相手の視点",
    phase: "問題の明確化 / ALACT 第2局面(相手の側)",
    description: "相手の側に立って、相手が何を考え、どう感じ、自分がどう映っていたかを想像する",
    goal: "相手の側に立った想像（相手が何を考え、感じ、望んでいたか、自分がどう映っていたか）が本人の言葉で語られた。相手の様子の観察だけでは足りない",
  },
  essence: {
    label: "本当の願い",
    phase: "問題の明確化 / ALACT 第3局面",
    description: "自分は本当は何を望んでいたのか、相手の望みとどこがずれていたのかに気づく",
    goal: "本人が本当は何を望んでいたかが、出来事の報告ではなく本人の気づきとして語られた",
  },
  closing_insight: {
    label: "問題の言い直し",
    phase: "問題の再定義 / ALACT 第3局面",
    description: "ここまでを通して、あらためていまの問題は何かを自分の言葉で言い直す",
    goal: "",
    answerRequired: true,
  },
  action_plan: {
    label: "次に試すこと",
    phase: "アクションプランの提示 / ALACT 第4局面",
    description: "ここまでを踏まえて、次の活動で試してみたいことを自分で決める",
    goal: "",
    answerRequired: true,
  },
  try_plan: {
    label: "行動計画",
    phase: "ALACT 第4局面",
    description: "次に試すことを、自分の言葉のまま整理する",
    goal: "",
  },
};

/**
 * 進め方 B で、1つのステージに使うターン数の目安。
 *
 * 質問会議でも問題の明確化は時間の目安で区切られている（舘野ら 2015 の表2では20分）。
 * 目安を超えても強制的には進めず、ファシリテーターに「ねらいに近いことが出ていれば
 * 終えてよい」と伝えるだけにする。上限で切ると話の途中で観点が切り替わるため。
 */
export const STAGE_TURN_BUDGET: Record<FacilitatedStage, number> = {
  problem: 1,
  fact: 4,
  feeling_other: 4,
  essence: 4,
};
