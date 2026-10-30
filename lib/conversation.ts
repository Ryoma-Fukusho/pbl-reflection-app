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
  buildContextText,
  facilitatedQuestionInstruction,
  facilitatorInput,
  type Facilitation,
  type FacilitatedStage,
} from "@/lib/prompts";
import type { MessageInput, SessionRecord, StoredMessage } from "@/lib/repository";
import { STAGE_GUIDE } from "@/lib/stage-guide";
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
  return messages
    .map((message) => {
      const label = message.stage ? STAGE_GUIDE[message.stage].label : "";
      return `${message.role === "assistant" ? "システム" : "学習者"}（${label}）: ${message.content}`;
    })
    .join("\n");
}

/** 判断が JSON として読めなかったときの代わり。進行を止めず、同じステージに留まる */
function fallbackFacilitation(): Facilitation {
  return {
    focus: "",
    thread: "",
    flow: "on_track",
    level: "not_yet",
    stage_done: false,
    reason: "判断の JSON を読めなかったため既定値を使った",
  };
}

export type Judgment = NonNullable<MessageInput["facilitation"]>;

/**
 * AI 対話版・進め方 B: ファシリテーターの判断。
 *
 * 直近の学習者の発言までを読ませ、扱っている問題・掘る話・話の状態と、
 * このステージのねらいがどこまで語られたか（ステージを終えてよいか）を判断させる。
 * 中身には介入しない。質問会議の ALC にあたる。
 */
export async function judgeStage(
  messages: Pick<StoredMessage, "role" | "content" | "stage">[],
  stage: FacilitatedStage,
  turnsInStage: number
): Promise<Judgment> {
  const judged = await generateText({
    systemInstruction: FACILITATOR_SYSTEM,
    turns: [{ role: "user", text: facilitatorInput({ stage, turnsInStage, transcript: toTranscript(messages) }) }],
    jsonSchema: FACILITATION_SCHEMA,
  });

  let judgment: Facilitation;
  try {
    judgment = JSON.parse(judged.text) as Facilitation;
  } catch (error) {
    console.error("facilitation parse failed", error, judged.text);
    judgment = fallbackFacilitation();
  }

  return { ...judgment, judgedStage: stage, turnsInStage, latencyMs: judged.latencyMs, usage: judged.usage };
}

/**
 * AI 対話版・進め方 B: ファシリテーターの判断を受けて、問いを1つ出す。質問会議のメンバーにあたる。
 *
 * @param stage 問いを出すステージ（判断したステージから進んだ場合は、進んだ先）
 * @param isNewStage このステージが今から始まるなら true
 * @param processAsked このステージで、話のつながりを尋ねる問いをすでに出したか
 */
export async function generateFacilitatedQuestion(
  session: SessionContext,
  messages: Pick<StoredMessage, "role" | "content">[],
  stage: FacilitatedStage,
  judgment: Judgment,
  isNewStage: boolean,
  processAsked: boolean
): Promise<MessageInput> {
  const systemInstruction = [
    COMMON_SYSTEM,
    facilitatedQuestionInstruction({ stage, isNewStage, processAsked, judgment }),
    `現在の Keep: ${session.keep || "未入力"}`,
    `現在の Problem: ${session.problem || "未入力"}`,
  ].join("\n");

  const result = await generateText({
    systemInstruction,
    turns: toTurns(session, messages),
  });

  return { ...toAssistantMessage(result, stage), facilitation: judgment };
}

/** ファシリテーターを通して問いを出すステージか（締めの問いは固定文言なので対象外） */
export function isFacilitatedStage(stage: Stage): stage is FacilitatedStage {
  return stage !== "closing_insight" && stage !== "try_plan";
}

/** 対話履歴とメモから Try（次回の行動計画）を生成する */
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
