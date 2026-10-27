import "server-only";

import { generateText, type ClaudeTurn } from "@/lib/claude";
import {
  COMMON_SYSTEM,
  FACILITATION_SCHEMA,
  FACILITATOR_SYSTEM,
  FINAL_USER_PROMPT,
  PROMPT_VERSION,
  STAGE_INSTRUCTIONS,
  TRY_PLAN_INSTRUCTION,
  STAGE_GOALS,
  buildContextText,
  facilitatedQuestionInstruction,
  facilitatorInput,
  formTurnInstruction,
  type Facilitation,
} from "@/lib/prompts";
import type { MessageInput, SessionRecord, StoredMessage } from "@/lib/repository";
import type { DialogueStage, Stage } from "@/lib/types";

/**
 * Claude に渡す会話の組み立て。
 *
 * 履歴はクライアントからではなく Firestore から読んだものを使う。
 * これが「ログの改ざんが原理的にできない」という性質の根拠になっている。
 */

type SessionContext = Pick<SessionRecord, "keep" | "problem" | "memo">;

function toTurns(session: SessionContext, messages: Pick<StoredMessage, "role" | "content">[]): ClaudeTurn[] {
  const turns: ClaudeTurn[] = [
    // 会話の先頭に前提文脈を1ターン置く。ステージが進んでも Keep/Problem を見失わないようにするため。
    { role: "user", text: buildContextText(session.keep, session.problem, session.memo) },
    ...messages.map((message) => ({
      role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
      text: message.content,
    })),
  ];

  // 進め方 B で空欄のまま次へ進むと、会話が assistant の問いで終わる。
  // 今のモデルは assistant で終わる会話（prefill）を 400 で拒否するため、
  // 何が起きたかを user として足す。DB には保存しない。
  if (turns[turns.length - 1].role === "assistant") {
    turns.push({ role: "user", text: "（学習者は答えずに次の観点へ進みました）" });
  }
  return turns;
}

function toAssistantMessage(
  result: Awaited<ReturnType<typeof generateText>>,
  stage: DialogueStage | "try_plan" | null
): MessageInput {
  return {
    role: "assistant",
    content: result.text,
    stage,
    generated: true,
    latencyMs: result.latencyMs,
    model: result.model,
    promptVersion: PROMPT_VERSION,
    finishReason: result.finishReason,
    usage: result.usage,
  };
}

/** AI 対話版・進め方 A: 次のステージの問いを生成する */
export async function generateStageQuestion(
  session: SessionContext,
  messages: Pick<StoredMessage, "role" | "content">[],
  stage: DialogueStage
): Promise<MessageInput> {
  const systemInstruction = [
    COMMON_SYSTEM,
    STAGE_INSTRUCTIONS[stage],
    `現在の Keep: ${session.keep || "未入力"}`,
    `現在の Problem: ${session.problem || "未入力"}`,
  ].join("\n");

  const result = await generateText({
    systemInstruction,
    turns: toTurns(session, messages),
  });

  return toAssistantMessage(result, stage);
}

/** ファシリテーターに読ませる書き起こし。どのステージの発話かが分かるようにする */
function toTranscript(messages: Pick<StoredMessage, "role" | "content" | "stage">[]): string {
  const stageLabel = (stage: Stage | null) => {
    if (stage && stage !== "try_plan" && stage !== "closing_insight") return STAGE_GOALS[stage].label;
    if (stage === "closing_insight") return "問題の言い直し";
    return "";
  };
  return messages
    .map((message) => `${message.role === "assistant" ? "システム" : "学習者"}（${stageLabel(message.stage)}）: ${message.content}`)
    .join("\n");
}

/** 判断が JSON として読めなかったときの代わり。問いの生成を止めないための保険 */
function fallbackFacilitation(stage: Exclude<DialogueStage, "closing_insight">): Facilitation {
  return {
    focus: "",
    flow: "on_track",
    covered: [],
    next_item: STAGE_GOALS[stage].items[0],
    stage_done: false,
    reason: "判断の JSON を読めなかったため既定値を使った",
  };
}

/**
 * AI 対話版・進め方 B: ファシリテーターの判断を経て、ステージの問いを生成する。
 *
 * 1回目の呼び出しで対話の進み方を判断させ（中身には介入しない）、
 * 2回目でその判断に沿った問いを1つ出させる。質問会議の ALC とメンバーの分担にあたる。
 *
 * @param isNewStage 学習者が前のステージを終えて、このステージが始まるところなら true
 */
export async function generateFacilitatedQuestion(
  session: SessionContext,
  messages: Pick<StoredMessage, "role" | "content" | "stage">[],
  stage: Exclude<DialogueStage, "closing_insight">,
  isNewStage: boolean
): Promise<MessageInput> {
  const judged = await generateText({
    systemInstruction: FACILITATOR_SYSTEM,
    turns: [{ role: "user", text: facilitatorInput({ stage, isNewStage, transcript: toTranscript(messages) }) }],
    jsonSchema: FACILITATION_SCHEMA,
  });

  let judgment: Facilitation;
  try {
    judgment = JSON.parse(judged.text) as Facilitation;
  } catch (error) {
    console.error("facilitation parse failed", error, judged.text);
    judgment = fallbackFacilitation(stage);
  }

  const systemInstruction = [
    COMMON_SYSTEM,
    facilitatedQuestionInstruction({ stage, isNewStage, judgment }),
    `現在の Keep: ${session.keep || "未入力"}`,
    `現在の Problem: ${session.problem || "未入力"}`,
  ].join("\n");

  const result = await generateText({
    systemInstruction,
    turns: toTurns(session, messages),
  });

  return {
    ...toAssistantMessage(result, stage),
    facilitation: { ...judgment, latencyMs: judged.latencyMs, usage: judged.usage },
  };
}

/** ファシリテーターを通して問いを出すステージか（締めの問いは固定文言なので対象外） */
export function isFacilitatedStage(stage: Stage): stage is Exclude<DialogueStage, "closing_insight"> {
  return stage !== "closing_insight" && stage !== "try_plan";
}

/** KWS フォーム版（統制群）: 既存のターン数ベースの問いを生成する */
export async function generateFormReply(
  session: SessionContext,
  messages: Pick<StoredMessage, "role" | "content">[],
  turn: number
): Promise<MessageInput> {
  const systemInstruction = [
    COMMON_SYSTEM,
    formTurnInstruction(turn),
    `現在の Keep: ${session.keep || "未入力"}`,
    `現在の Problem: ${session.problem || "未入力"}`,
  ].join("\n");

  const result = await generateText({
    systemInstruction,
    turns: toTurns(session, messages),
  });

  return toAssistantMessage(result, null);
}

/** 両条件共通: 対話履歴とメモから Try（次回の行動計画）を生成する */
export async function generateTryPlan(
  session: SessionContext,
  messages: Pick<StoredMessage, "role" | "content">[],
  stage: DialogueStage | "try_plan" | null
): Promise<MessageInput> {
  const systemInstruction = [
    COMMON_SYSTEM,
    TRY_PLAN_INSTRUCTION,
    `Keep: ${session.keep || "未入力"}`,
    `Problem: ${session.problem || "未入力"}`,
    `Memo: ${session.memo || "未入力"}`,
  ].join("\n");

  const result = await generateText({
    systemInstruction,
    turns: [...toTurns(session, messages), { role: "user", text: FINAL_USER_PROMPT }],
  });

  return toAssistantMessage(result, stage);
}
