import type { Stage } from "@/lib/types";

/**
 * 各ステージが ALACT モデルのどこにあたり、何を聞けば十分とみなすか。
 *
 * 画面（振り返りの進み方の表示）と、進め方 B のファシリテーターの両方がこれを使う。
 * ファシリテーターは「聞けた観点」を items の文言そのままで返すので、
 * 画面のチェック表示と判断が同じ文言で対応する。
 *
 * items を変えると、ファシリテーターの判断と問いが変わる。変えるときは
 * lib/prompts の PROMPT_VERSION も上げること。
 *
 * このファイルはブラウザにも読み込まれるので server-only なものを import しないこと。
 */

export type StageGuide = {
  /** 画面とプロンプトで使うステージの名前 */
  label: string;
  /** ALACT モデルのどの局面にあたるか */
  phase: string;
  /** このステージで何をするかの一言。学習者が一人で振り返るときにも使えるように書く */
  description: string;
  /** 聞けば十分とみなす観点。締めの問いと Try には無い */
  items: string[];
};

export const STAGE_GUIDE: Record<Stage, StageGuide> = {
  keep: {
    label: "うまくいったこと",
    phase: "第1局面 行為",
    description: "今日の活動でうまくいったこと、続けたいことを思い出す",
    items: ["うまくいったこと・続けたいこと", "そのとき自分がしたこと"],
  },
  problem: {
    label: "引っかかったこと",
    phase: "第2局面 行為の振り返り",
    description: "引っかかったこと、モヤモヤしたことを1つ選ぶ",
    items: ["引っかかったこと・モヤモヤしたこと", "それが起きた場面（いつ・どこで・誰と）"],
  },
  fact: {
    label: "その場面で起きたことと自分",
    phase: "第2局面 行為の振り返り(自分の側)",
    description: "その場面で何が起き、自分が何をし、何を考え、どう感じたかを思い出す",
    items: [
      "その場面で何が起きたか",
      "自分は何をしたか・しなかったか",
      "自分は何を考えていたか",
      "自分はどう感じていたか",
    ],
  },
  feeling_other: {
    label: "相手の側から見たこと",
    phase: "第2局面 行為の振り返り(相手の側)",
    description: "相手の側に立って、相手が何をし、何を考え、どう感じ、何を望んでいたかを想像する",
    items: [
      "相手は何をしていたか",
      "相手は何を考えていたか",
      "相手はどう感じていたか",
      "相手は何を望んでいたか",
      "相手から自分の行動はどう映っていたか",
    ],
  },
  essence: {
    label: "本当の願い",
    phase: "第3局面 本質的な諸相への気づき",
    description: "自分は本当は何を望んでいたのか、相手の望みとどこがずれていたのかに気づく",
    items: [
      "自分は本当は何を望んでいたか",
      "自分の望みと相手の望みのずれ",
      "それが自分にとって大事な理由",
    ],
  },
  closing_insight: {
    label: "問題の言い直し",
    phase: "第3局面 本質的な諸相への気づき",
    description: "ここまでを通して、あらためていまの問題は何かを自分の言葉で言い直す",
    items: [],
  },
  try_plan: {
    label: "行動計画",
    phase: "第4局面 行為の選択肢の拡大",
    description: "次のPBL活動で意識することを決める",
    items: [],
  },
};

/**
 * ファシリテーターが返した「聞けた観点」に、この観点が入っているか。
 * 文言そのままで返す指示にしているが、括弧の有無などの揺れは許す。
 */
export function isItemCovered(item: string, covered: string[]): boolean {
  const normalize = (text: string) => text.replace(/[\s「」（）()]/g, "");
  const target = normalize(item);
  return covered.some((entry) => {
    const value = normalize(entry);
    if (!value) return false;
    return value === target || value.includes(target) || target.includes(value);
  });
}
