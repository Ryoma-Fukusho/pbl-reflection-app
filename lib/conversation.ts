import "server-only";

import { generateText, type ClaudeTurn } from "@/lib/claude";
import {
  ACKNOWLEDGE_INSTRUCTION,
  ACTION_PLAN_INSTRUCTION,
  COMMON_SYSTEM,
  FACILITATION_SCHEMA,
  FACILITATOR_SYSTEM,
  PROMPT_VERSION,
  TRY_PLAN_INSTRUCTION,
  TRY_PLAN_REQUEST,
  buildContextText,
  facilitatedQuestionInstruction,
  facilitatorInput,
  stageQuestionInstruction,
  type Facilitation,
} from "@/lib/prompts";
import type { MessageInput, SessionRecord, StoredMessage } from "@/lib/repository";
import { STAGE_GUIDE, decideStage } from "@/lib/stage-guide";
import type { DialogueStage, FacilitatedStage, GeneratedStage } from "@/lib/types";

/**
 * Claude に渡す会話の組み立て。
 *
 * 履歴はクライアントからではなく Firestore から読んだものを使う。
 * これが「ログの改ざんが原理的にできない」という性質の根拠になっている。
 */

type SessionContext = Pick<SessionRecord, "problem" | "memo">;

function toTurns(session: SessionContext, messages: Pick<StoredMessage, "role" | "content">[]): ClaudeTurn[] {
  const turns: ClaudeTurn[] = [
    // 会話の先頭に前提文脈を1ターン置く。ステージが進んでも最初の問題を見失わないようにするため。
    { role: "user", text: buildContextText(session.problem, session.memo) },
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

/** 進め方 A: 次のステージの問いを生成する */
export async function generateStageQuestion(
  session: SessionContext,
  messages: Pick<StoredMessage, "role" | "content">[],
  stage: GeneratedStage
): Promise<MessageInput> {
  const systemInstruction = [COMMON_SYSTEM, stageQuestionInstruction(stage)].join("\n");

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
  turnsInStage: number,
  pressedNext: boolean
): Promise<Judgment> {
  const judged = await generateText({
    systemInstruction: FACILITATOR_SYSTEM,
    turns: [{ role: "user", text: facilitatorInput({ stage, transcript: toTranscript(messages) }) }],
    jsonSchema: FACILITATION_SCHEMA,
  });

  let judgment: Facilitation;
  try {
    judgment = JSON.parse(judged.text) as Facilitation;
  } catch (error) {
    console.error("facilitation parse failed", error, judged.text);
    judgment = fallbackFacilitation();
  }

  // 終えるかどうかはコードで決める（lib/stage-guide.ts の decideStage）
  const decision = decideStage({ stage, turnsInStage, level: judgment.level, flow: judgment.flow, pressedNext });
  return { ...judgment, judgedStage: stage, turnsInStage, decision, latencyMs: judged.latencyMs, usage: judged.usage };
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
  stage: GeneratedStage,
  judgment: Judgment,
  isNewStage: boolean,
  processAsked: boolean
): Promise<MessageInput> {
  const nudge = !isNewStage && judgment.decision === "nudge";
  const systemInstruction = [
    COMMON_SYSTEM,
    facilitatedQuestionInstruction({ stage, isNewStage, processAsked, nudge, judgment }),
  ].join("\n");

  const result = await generateText({
    systemInstruction,
    turns: toTurns(session, messages),
  });

  return { ...toAssistantMessage(result, stage), facilitation: judgment };
}

/** 「次に試すこと」への答えを中心に、Try を本人の言葉のまま整理する */
/**
 * 締めの問いの直前に置く受け止めを生成する。締めの問い自体は固定文言のまま。
 * 進め方 B では、直前のステージの判断をこのメッセージに残す（固定文言には判断を付けないため）。
 */
export async function generateAcknowledgement(
  session: SessionContext,
  messages: Pick<StoredMessage, "role" | "content">[],
  judgment: Judgment | null
): Promise<MessageInput> {
  const result = await generateText({
    systemInstruction: [COMMON_SYSTEM, ACKNOWLEDGE_INSTRUCTION].join("\n"),
    turns: toTurns(session, messages),
  });
  // 受け止めに問いが混ざると、直後の締めの問いと問いが2つ並ぶ。指示しても混ざることがあるので、
  // 問いの文を取り除く。残らなければ短い受け止めに置き換える
  const sentences = result.text.match(/[^。！？!?]+[。！？!?]?/g) ?? [];
  const kept = sentences.filter((sentence) => !isQuestionSentence(sentence)).join("").trim();
  return {
    ...toAssistantMessage({ ...result, text: kept || "話してくれて、ありがとうございます。" }, "closing_insight"),
    facilitation: judgment ?? undefined,
  };
}

/** 問いの文か。「？」を含むか、「〜か。」「〜かな。」のように「か」で終わる文を問いとみなす */
function isQuestionSentence(sentence: string): boolean {
  return /[？?]/.test(sentence) || /(か|かな|かね)[。．]?\s*$/.test(sentence.trim());
}

/** 次に試すことを本人に問う。締めの答えを受け止めて、会話の流れで聞く */
export async function generateActionPlanQuestion(
  session: SessionContext,
  messages: Pick<StoredMessage, "role" | "content">[]
): Promise<MessageInput> {
  const result = await generateText({
    systemInstruction: [COMMON_SYSTEM, ACTION_PLAN_INSTRUCTION].join("\n"),
    turns: toTurns(session, messages),
  });
  return toAssistantMessage(result, "action_plan");
}

export async function generateTryPlan(
  session: SessionContext,
  messages: Pick<StoredMessage, "role" | "content">[],
  stage: DialogueStage | "try_plan" | null
): Promise<MessageInput> {
  const result = await generateText({
    systemInstruction: [COMMON_SYSTEM, TRY_PLAN_INSTRUCTION].join("\n"),
    turns: [...toTurns(session, messages), { role: "user", text: TRY_PLAN_REQUEST }],
  });

  return toAssistantMessage(result, stage);
}
