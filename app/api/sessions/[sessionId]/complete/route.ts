import type { NextRequest } from "next/server";

import { authenticateRequest } from "@/lib/auth";
import { generateTryPlan } from "@/lib/conversation";
import {
  appendMessages,
  completionPatch,
  getMessages,
  getOwnedSession,
  toChatMessage,
  toSummary,
} from "@/lib/repository";
import { conflict, errorResponse, notFound, readJsonBody, readString } from "@/lib/route-utils";
import type { CompleteSessionResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 対話を締めて Try（次回の行動計画）を生成し、セッションを完了状態にする。
 * 実験群・統制群のどちらも同じ経路を通る。
 */
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/sessions/[sessionId]/complete">
) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) {
    return auth.response;
  }

  const { sessionId } = await ctx.params;
  const body = await readJsonBody(request);
  const memo = readString(body?.memo);

  try {
    const session = await getOwnedSession(sessionId, auth.user.uid);
    if (!session) {
      return notFound("セッションが見つかりません。");
    }
    if (session.status !== "active") {
      return conflict("このセッションは既に完了しています。");
    }

    if (session.condition === "dialogue" && session.stage !== "try_plan") {
      return conflict("対話が最後まで終わっていません。");
    }

    const history = await getMessages(sessionId);
    if (history.length === 0) {
      return conflict("対話の記録がないため Try を生成できません。");
    }

    const context = { keep: session.keep, problem: session.problem, memo: memo || session.memo };

    // Try のメッセージには常に stage: "try_plan" を付ける（統制群も同じ）。
    // 全文の記録としては messages に残しつつ、UI ではこの印を頼りに
    // チャットログから除いて専用カードとして1回だけ表示する。
    const plan = await generateTryPlan(context, history, "try_plan");

    const stored = await appendMessages({
      sessionId,
      startSeq: history.length,
      messages: [plan],
      sessionPatch: {
        tryPlan: plan.content,
        memo: context.memo,
        ...completionPatch(session.startedAt),
      },
    });

    return Response.json({
      session: {
        ...toSummary(session),
        memo: context.memo,
        status: "completed",
        tryPlan: plan.content,
      },
      messages: stored.map(toChatMessage),
      tryPlan: plan.content,
    } satisfies CompleteSessionResponse);
  } catch (error) {
    return errorResponse(error, "Try の生成に失敗しました。");
  }
}
