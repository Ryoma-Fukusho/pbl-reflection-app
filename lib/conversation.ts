import "server-only";

import { generateText, type ClaudeTurn } from "@/lib/claude";
import {
  COMMON_SYSTEM,
  FINAL_USER_PROMPT,
  PROMPT_VERSION,
  STAGE_INSTRUCTIONS,
  TRY_PLAN_INSTRUCTION,
  buildContextText,
  followupInstruction,
  formTurnInstruction,
} from "@/lib/prompts";
import type { MessageInput, SessionRecord, StoredMessage } from "@/lib/repository";
import type { DialogueStage } from "@/lib/types";

/**
 * Claude に渡す会話の組み立て。
 *
 * 履歴はクライアントからではなく Firestore から読んだものを使う。
 * これが「ログの改ざんが原理的にできない」という性質の根拠になっている。
 */

type SessionContext = Pick<SessionRecord, "keep" | "problem" | "memo">;

function toTurns(session: SessionContext, messages: Pick<StoredMessage, "role" | "content">[]): ClaudeTurn[] {
  return [
    // 会話の先頭に前提文脈を1ターン置く。ステージが進んでも Keep/Problem を見失わないようにするため。
    { role: "user", text: buildContextText(session.keep, session.problem, session.memo) },
    ...messages.map((message) => ({
      role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
      text: message.content,
    })),
  ];
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

/**
 * AI 対話版: ステージの問いを生成する。
 *
 * followup が true なら、次のステージへ進まず同じステージの中で掘り下げる問いにする
 * （進め方 B で学習者が「この話を続ける」を選んだとき）。
 */
export async function generateStageQuestion(
  session: SessionContext,
  messages: Pick<StoredMessage, "role" | "content">[],
  stage: DialogueStage,
  followup = false
): Promise<MessageInput> {
  const systemInstruction = [
    COMMON_SYSTEM,
    followup && stage !== "closing_insight" ? followupInstruction(stage) : STAGE_INSTRUCTIONS[stage],
    `現在の Keep: ${session.keep || "未入力"}`,
    `現在の Problem: ${session.problem || "未入力"}`,
  ].join("\n");

  const result = await generateText({
    systemInstruction,
    turns: toTurns(session, messages),
  });

  return toAssistantMessage(result, stage);
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
