import type { NextRequest } from "next/server";

import { authenticateRequest } from "@/lib/auth";
import {
  generateFacilitatedQuestion,
  generateStageQuestion,
  isFacilitatedStage,
  judgeStage,
  type Judgment,
} from "@/lib/conversation";
import { FIXED_MESSAGES } from "@/lib/prompts";
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
import { isDialogueStage, nextStage, type PostMessageResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

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

  // 進め方 B で「次の観点へ」を押した場合だけ、空欄を許す（答えずに次へ進む）。
  // 許すかどうかはセッションを読んでから判断する
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
    // 締めの問いと初期入力のステージ（Problem）は、答えずに進めない
    const answerRequired =
      session.stage === "closing_insight" || (session.stage !== null && STAGE_GUIDE[session.stage].initialInput === true);
    if (!content && !(isFlexible && wantsNext && !answerRequired)) {
      return badRequest("入力が空です。");
    }

    const history = await getMessages(sessionId);
    const startSeq = history.length;

    // サーバーがステージを進める
    const currentStage = session.stage;
    if (!isDialogueStage(currentStage)) {
      return conflict("対話は完了しています。Try の生成に進んでください。");
    }

    // 空欄のまま次へ進んだ場合は、学習者の発話を記録しない
    const userMessage: MessageInput | null = content
      ? {
          role: "user",
          content,
          stage: currentStage,
          generated: false,
          composeMs,
          choice: isFlexible ? (wantsNext ? "next" : "send") : undefined,
        }
      : null;

    // ステージごとに、回答をセッションの対応フィールドへ写す。
    // 進め方 B では同じステージで複数回答えることがあるので、改行でつなげて全て残す。
    const append = (previous: string) => (!content ? previous : previous ? `${previous}\n${content}` : content);
    const updated = {
      keep: currentStage === "keep" ? append(session.keep) : session.keep,
      problem: currentStage === "problem" ? append(session.problem) : session.problem,
      memo: memo || session.memo,
    };

    const outgoing: MessageInput[] = userMessage ? [userMessage] : [];
    const sofar = [...history, ...outgoing];

    // 進むかどうか。進め方 A は常に進む。
    // 進め方 B はファシリテーターが「このステージのねらいが語られた」と判断したら進み、
    // 学習者が「次の観点へ」を押したら判断によらず進む。締めの問いは1回で答えるので進む。
    // 判断は毎回行う。進む場合も、扱っている問題と掘る話を次のステージの問いに引き継ぐため。
    let judgment: Judgment | null = null;
    if (isFlexible && isFacilitatedStage(currentStage)) {
      const turnsInStage = sofar.filter((message) => message.role === "user" && message.stage === currentStage).length;
      judgment = await judgeStage(sofar, currentStage, turnsInStage);
    }
    // 初期入力のステージ（Problem）は掘り下げず、1回答えたら進む
    const stay =
      judgment !== null && !wantsNext && !judgment.stage_done && STAGE_GUIDE[currentStage].initialInput !== true;
    const next = stay ? currentStage : nextStage(currentStage);
    const turnCount = session.turnCount + (userMessage ? 1 : 0);

    const sessionPatch: Record<string, unknown> = {
      stage: next,
      turnCount,
      keep: updated.keep,
      problem: updated.problem,
      memo: updated.memo,
    };

    if (currentStage === "closing_insight") {
      // 締めの問いへの回答。内省の深さを測る主要データ。
      sessionPatch.closingInsight = content;
    }

    if (next === "closing_insight") {
      // 締めの問いは AI に生成させず固定文言を使う（全参加者に同一の問いを提示するため）
      outgoing.push({
        role: "assistant",
        content: FIXED_MESSAGES.closing_insight,
        stage: "closing_insight",
        generated: false,
        skipped: !userMessage || undefined,
      });
    } else if (judgment && isFacilitatedStage(next)) {
      // 進め方 B: 判断を受けて問いを出す。stay なら同じステージの続き。
      // 話のつながりを尋ねる問いは1つのステージで1回まで。出したかどうかは、
      // このステージで「それている」と判断して出した問いがあるかで見る
      const processAsked = sofar.some(
        (message) => message.role === "assistant" && message.stage === next && message.facilitation?.flow === "drifting"
      );
      const question = await generateFacilitatedQuestion(updated, sofar, next, judgment, !stay, stay && processAsked);
      outgoing.push({ ...question, skipped: !userMessage || undefined });
    } else if (next !== "try_plan") {
      // 進め方 A: 直前のユーザー発言を含めた履歴を渡して、それに応答する問いを生成させる
      outgoing.push(await generateStageQuestion(updated, sofar, next));
    }
    // next === "try_plan" のときは新たな問いを出さず、Try 生成を待つ

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
        closingInsight: currentStage === "closing_insight" ? content : session.closingInsight,
      },
      messages: stored.map(toChatMessage),
    } satisfies PostMessageResponse);
  } catch (error) {
    return errorResponse(error, "AI 応答の生成中にエラーが発生しました。");
  }
}
