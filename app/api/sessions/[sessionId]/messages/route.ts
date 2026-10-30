import type { NextRequest } from "next/server";

import { authenticateRequest } from "@/lib/auth";
import { generateFacilitatedQuestion, generateStageQuestion, judgeStage, type Judgment } from "@/lib/conversation";
import { FIXED_MESSAGES, closingQuestion } from "@/lib/prompts";
import {
  appendMessages,
  getMessages,
  getOwnedSession,
  toChatMessage,
  toSummary,
  type MessageInput,
} from "@/lib/repository";
import {
  badRequest,
  conflict,
  errorResponse,
  notFound,
  readJsonBody,
  readString,
} from "@/lib/route-utils";
import { STAGE_GUIDE } from "@/lib/stage-guide";
import {
  isDialogueStage,
  isFacilitatedStage,
  isGeneratedStage,
  nextStage,
  type DialogueStage,
  type PostMessageResponse,
} from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/** 固定文言のステージへの回答を写す、セッションのフィールド */
const ANSWER_FIELDS: Partial<Record<DialogueStage, "closingInsight" | "actionPlan" | "sessionReview">> = {
  closing_insight: "closingInsight",
  action_plan: "actionPlan",
  session_review: "sessionReview",
};

/**
 * 1ターン分の対話を処理する。
 *
 * クライアントが送るのは「今回の1発言」だけで、会話履歴は送らせない。
 * 履歴の正本は Firestore にあり、サーバーがそこから読む。
 * これによりブラウザ側から過去の発言を書き換えて送ることができなくなる。
 */
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/sessions/[sessionId]/messages">
) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) {
    return auth.response;
  }

  // Next 16 では動的セグメントの params は await が必須
  const { sessionId } = await ctx.params;

  const body = await readJsonBody(request);
  if (!body) {
    return badRequest("リクエスト形式が不正です。");
  }

  // 空欄を許すかどうかはセッションを読んでから判断する
  const content = readString(body.content);

  const memo = readString(body.memo);
  const composeMs = typeof body.composeMs === "number" && body.composeMs >= 0 ? body.composeMs : undefined;
  const wantsNext = body.next === true;

  try {
    const session = await getOwnedSession(sessionId, auth.user.uid);
    if (!session) {
      return notFound("セッションが見つかりません。");
    }
    if (session.status !== "active") {
      return conflict("このセッションは既に完了しています。");
    }

    const isFlexible = session.turnMode === "flexible";
    // 答えずに進めるのは、進め方 B の「次の観点へ」と、振り返りの振り返りの「答えずに終える」だけ。
    // 問題提示・締めの問い・次に試すことは答えないと進めない
    const canSkip =
      wantsNext &&
      session.stage !== null &&
      STAGE_GUIDE[session.stage].answerRequired !== true &&
      (isFlexible || session.stage === "session_review");
    if (!content && !canSkip) {
      return badRequest("入力が空です。");
    }

    const history = await getMessages(sessionId);
    const startSeq = history.length;

    // サーバーがステージを進める
    const currentStage = session.stage;
    if (!isDialogueStage(currentStage)) {
      return conflict("対話は完了しています。Try の整理に進んでください。");
    }

    // 空欄のまま次へ進んだ場合は、学習者の発話を記録しない
    const userMessage: MessageInput | null = content
      ? {
          role: "user",
          content,
          stage: currentStage,
          generated: false,
          composeMs,
          choice: isFlexible && isFacilitatedStage(currentStage) ? (wantsNext ? "next" : "send") : undefined,
        }
      : null;

    // 最初の問題は、後の問いの前提文脈として使うので別に持つ
    const updated = {
      problem: currentStage === "problem" ? content : session.problem,
      memo: memo || session.memo,
    };

    const outgoing: MessageInput[] = userMessage ? [userMessage] : [];
    const sofar = [...history, ...outgoing];

    // 進むかどうか。進め方 A は常に進む。
    // 進め方 B はファシリテーターが「このステージのねらいが語られた」と判断したら進み、
    // 学習者が「次の観点へ」を押したら判断によらず進む。固定文言のステージは1回で進む。
    // 判断は毎回行う。進む場合も、扱っている問題と掘る話を次のステージの問いに引き継ぐため。
    let judgment: Judgment | null = null;
    if (isFlexible && isFacilitatedStage(currentStage)) {
      const turnsInStage = sofar.filter((message) => message.role === "user" && message.stage === currentStage).length;
      judgment = await judgeStage(sofar, currentStage, turnsInStage);
    }
    // 初期入力のステージ（問題提示）は掘り下げず、1回答えたら進む
    const stay =
      judgment !== null && !wantsNext && !judgment.stage_done && STAGE_GUIDE[currentStage].initialInput !== true;
    const next = stay ? currentStage : nextStage(currentStage);
    const turnCount = session.turnCount + (userMessage ? 1 : 0);

    const sessionPatch: Record<string, unknown> = {
      stage: next,
      turnCount,
      problem: updated.problem,
      memo: updated.memo,
    };

    // 固定文言のステージへの回答を、セッションの対応フィールドに写す。
    // closingInsight は内省の深さを測る主要データ
    const answerField = ANSWER_FIELDS[currentStage];
    if (answerField) {
      sessionPatch[answerField] = content;
    }

    if (next === "closing_insight" || next === "action_plan" || next === "session_review") {
      // 固定文言のステージは AI に生成させない（全参加者に同じ型の問いを提示するため）
      outgoing.push({
        role: "assistant",
        // 締めの問いは型が共通で、本人が最初に書いた問題だけを差し込む
        content: next === "closing_insight" ? closingQuestion(updated.problem) : FIXED_MESSAGES[next],
        stage: next,
        generated: false,
        skipped: !userMessage || undefined,
      });
    } else if (judgment && isGeneratedStage(next)) {
      // 進め方 B: 判断を受けて問いを出す。stay なら同じステージの続き。
      // 話のつながりを尋ねる問いは1つのステージで1回まで。出したかどうかは、
      // このステージで「それている」と判断して出した問いがあるかで見る
      const processAsked = sofar.some(
        (message) => message.role === "assistant" && message.stage === next && message.facilitation?.flow === "drifting"
      );
      const question = await generateFacilitatedQuestion(updated, sofar, next, judgment, !stay, stay && processAsked);
      outgoing.push({ ...question, skipped: !userMessage || undefined });
    } else if (isGeneratedStage(next)) {
      // 進め方 A: 直前のユーザー発言を含めた履歴を渡して、それに応答する問いを生成させる
      outgoing.push(await generateStageQuestion(updated, sofar, next));
    }
    // next === "try_plan" のときは新たな問いを出さず、Try の整理を待つ

    const stored = await appendMessages({
      sessionId,
      startSeq,
      messages: outgoing,
      sessionPatch,
    });

    return Response.json({
      session: {
        ...toSummary(session),
        ...updated,
        stage: next,
        turnCount,
        ...(answerField ? { [answerField]: content } : {}),
      },
      messages: stored.map(toChatMessage),
    } satisfies PostMessageResponse);
  } catch (error) {
    return errorResponse(error, "AI 応答の生成中にエラーが発生しました。");
  }
}
