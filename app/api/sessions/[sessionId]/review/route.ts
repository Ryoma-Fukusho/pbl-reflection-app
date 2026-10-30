import type { NextRequest } from "next/server";

import { authenticateRequest } from "@/lib/auth";
import { getOwnedSession, saveSessionReview, toSummary } from "@/lib/repository";
import { badRequest, conflict, errorResponse, notFound, readJsonBody, readString } from "@/lib/route-utils";
import type { ReviewSessionResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 振り返りの振り返り（任意）を保存する。質問会議の最後の「質問会議の振り返り」にあたる。
 *
 * 対話の流れには入れず、Try を整理した後に任意で送ってもらう。
 * どの問いが考えるきっかけになったかを本人が言葉にしておくと、次に一人で振り返るときに
 * 自分にその問いを向けられる。
 */
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/sessions/[sessionId]/review">
) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) {
    return auth.response;
  }

  const { sessionId } = await ctx.params;
  const body = await readJsonBody(request);
  const content = readString(body?.content);
  if (!content) {
    return badRequest("入力が空です。");
  }

  try {
    const session = await getOwnedSession(sessionId, auth.user.uid);
    if (!session) {
      return notFound("セッションが見つかりません。");
    }
    if (session.status !== "completed") {
      return conflict("振り返りが終わってから送ってください。");
    }

    await saveSessionReview(sessionId, content);

    return Response.json({
      session: { ...toSummary(session), sessionReview: content },
    } satisfies ReviewSessionResponse);
  } catch (error) {
    return errorResponse(error, "送信に失敗しました。");
  }
}
