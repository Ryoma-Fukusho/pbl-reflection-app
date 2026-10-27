import type { NextRequest } from "next/server";

import { authenticateRequest } from "@/lib/auth";
import { abandonSession, getOwnedSession } from "@/lib/repository";
import { errorResponse, notFound } from "@/lib/route-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * 途中でやめたセッションに印を付ける。
 *
 * 「中断する」「すべてリセット」を押したときに呼ばれる。
 * これがないと離脱セッションが active のまま残り、分析時に
 * 「まだ途中の人」と「やめた人」を区別できなくなる。
 *
 * ブラウザを閉じただけの離脱までは捕まえられない（beforeunload は信用できない）。
 * その分は startedAt から時間が経った active を後から離脱とみなして扱う。
 */
export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/sessions/[sessionId]/abandon">
) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) {
    return auth.response;
  }

  const { sessionId } = await ctx.params;

  try {
    const session = await getOwnedSession(sessionId, auth.user.uid);
    if (!session) {
      return notFound("セッションが見つかりません。");
    }

    // 完了済みのセッションを後から離脱扱いに落とさない。
    // 二重送信や、完了直後にリセットを押した場合に記録が壊れるのを防ぐ。
    if (session.status === "active") {
      await abandonSession(sessionId, session.startedAt);
    }

    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "セッションの中断処理に失敗しました。");
  }
}
