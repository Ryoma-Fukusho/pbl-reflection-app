import "server-only";

import { generateText, type ClaudeTurn } from "@/lib/claude";
import {
  ACKNOWLEDGE_INSTRUCTION,
  ACTION_PLAN_INSTRUCTION,
  COMMON_SYSTEM,
  FACILITATION_SCHEMA,
  FACILITATOR_SYSTEM,
  ONE_QUESTION_RETRY,
  PROMPT_VERSION,
  TRY_PLAN_INSTRUCTION,
  TRY_PLAN_REQUEST,
  buildContextText,
  facilitatedQuestionInstruction,
  facilitatorInput,
  type Facilitation,
} from "@/lib/prompts";
import type { MessageInput, SessionRecord, StoredMessage } from "@/lib/repository";
import { STAGE_GUIDE, STEP2_STAGES, decideStage } from "@/lib/stage-guide";
import type { DialogueStage, FacilitatedStage, GeneratedStage } from "@/lib/types";

/**
 * Claude に渡す会話の組み立て。
 *
 * 履歴はクライアントからではなく Firestore から読んだものを使う。
 * これが「ログの改ざんが原理的にできない」という性質の根拠になっている。
 */

type SessionContext = Pick<SessionRecord, "problem">;

function toTurns(session: SessionContext, messages: Pick<StoredMessage, "role" | "content">[]): ClaudeTurn[] {
  const turns: ClaudeTurn[] = [
    // 会話の先頭に前提文脈を1ターン置く。ステージが進んでも最初の問題を見失わないようにするため。
    { role: "user", text: buildContextText(session.problem) },
    ...messages.map((message) => ({
      role: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
      text: message.content,
    })),
  ];
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

/** 文に分ける。問いの数を数えるのと、問いの文を取り除くのに使う */
function splitSentences(text: string): string[] {
  return text.match(/[^。！？!?]+[。！？!?]?/g) ?? [];
}

/** 問いの文か。「？」を含むか、「〜か。」「〜かな。」のように「か」で終わる文を問いとみなす */
function isQuestionSentence(sentence: string): boolean {
  return /[？?]/.test(sentence) || /(か|かな|かね)[。．]?\s*$/.test(sentence.trim());
}

function countQuestions(text: string): number {
  return splitSentences(text).filter(isQuestionSentence).length;
}

/**
 * 問いを1つ出す返答を生成する。
 *
 * 指示しても問いが2つ以上並ぶことがあるので、生成後に数え、多ければ一度だけ作り直す。
 * それでも多ければ、最後の問い以外の問いの文を取り除く（最後の問いが、返答として答えてほしい問い）。
 * 1つの文の中に問いを並べた場合（「いつで、どう終わったか」）は数えられないので、指示の側で防ぐ。
 */
async function generateOneQuestion(systemInstruction: string, turns: ClaudeTurn[]) {
  const first = await generateText({ systemInstruction, turns });
  if (countQuestions(first.text) <= 1) {
    return first;
  }
  const retry = await generateText({ systemInstruction: `${systemInstruction}\n${ONE_QUESTION_RETRY}`, turns });
  const sentences = splitSentences(retry.text);
  const lastQuestion = sentences.findLastIndex(isQuestionSentence);
  const text =
    countQuestions(retry.text) <= 1
      ? retry.text
      : sentences.filter((sentence, index) => !isQuestionSentence(sentence) || index === lastQuestion).join("").trim();
  return { ...retry, text, latencyMs: first.latencyMs + retry.latencyMs };
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

/** 判断が JSON として読めなかったときの代わり。同じステージに留まるが、上限の規則で進行は止まらない */
function fallbackFacilitation(): Facilitation {
  return {
    focus: "",
    thread: "",
    flow: "on_track",
    goal_met: false,
    saturated: false,
    reason: "判断の JSON を読めなかったため既定値を使った",
  };
}

export type Judgment = NonNullable<MessageInput["facilitation"]>;

/**
 * ファシリテーターの判断。
 *
 * 直近の学習者の発言までを読ませ、扱っている問題・掘る話・話の状態と、
 * このステージのねらいが満たされたか、新しく出てくるものが尽きたかを判断させる。
 * 中身には介入しない。質問会議の ALC にあたる。
 */
export async function judgeStage(
  messages: Pick<StoredMessage, "role" | "content" | "stage" | "facilitation">[],
  stage: FacilitatedStage
): Promise<Judgment> {
  const userTurns = messages.filter((message) => message.role === "user");
  const turnsInStage = userTurns.filter((message) => message.stage === stage).length;
  const step2Turns = userTurns.filter((message) => message.stage !== null && (STEP2_STAGES as readonly string[]).includes(message.stage)).length;
  // このステージの1つ前の判断。2回続けて出し切っていたら進むのに使う
  const previous = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.facilitation?.judgedStage === stage)?.facilitation;

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
  const decision = decideStage({
    stage,
    turnsInStage,
    step2Turns,
    goalMet: judgment.goal_met,
    saturated: judgment.saturated,
    previousSaturated: previous?.saturated === true,
    flow: judgment.flow,
  });
  return { ...judgment, judgedStage: stage, turnsInStage, decision, latencyMs: judged.latencyMs, usage: judged.usage };
}

/**
 * ファシリテーターの判断を受けて、問いを1つ出す。質問会議のメンバーにあたる。
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

  const result = await generateOneQuestion(systemInstruction, toTurns(session, messages));
  return { ...toAssistantMessage(result, stage), facilitation: judgment };
}

/**
 * 締めの問いの直前に置く受け止めを生成する。締めの問い自体は固定文言のまま。
 * 直前のステージの判断をこのメッセージに残す（固定文言には判断を付けないため）。
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
  const kept = splitSentences(result.text).filter((sentence) => !isQuestionSentence(sentence)).join("").trim();
  return {
    ...toAssistantMessage({ ...result, text: kept || "話してくれて、ありがとうございます。" }, "closing_insight"),
    facilitation: judgment ?? undefined,
  };
}

/** 次に試すことを本人に問う。締めの答えを受け止めて、会話の流れで聞く */
export async function generateActionPlanQuestion(
  session: SessionContext,
  messages: Pick<StoredMessage, "role" | "content">[]
): Promise<MessageInput> {
  const result = await generateOneQuestion([COMMON_SYSTEM, ACTION_PLAN_INSTRUCTION].join("\n"), toTurns(session, messages));
  return toAssistantMessage(result, "action_plan");
}

/** 「次に試すこと」への答えを中心に、Try を本人の言葉のまま整理する */
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
