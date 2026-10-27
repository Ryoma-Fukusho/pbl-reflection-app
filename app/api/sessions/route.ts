import type { NextRequest } from "next/server";

import { authenticateRequest, upsertUser } from "@/lib/auth";
import { FIXED_MESSAGES } from "@/lib/prompts";
import { appendMessages, createSession, toChatMessage, toSummary } from "@/lib/repository";
import { badRequest, errorResponse, readJsonBody } from "@/lib/route-utils";
import { isTurnMode, type CreateSessionResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 振り返りセッションを開始する。
 *
 * 固定の問いかけ1件だけを置いて返す。まだ学習者の発言が無いので AI に生成させる
 * 材料が無く、また全参加者の入り口を揃えたいので固定文言にしている。
 */
export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if (!auth.ok) {
    return auth.response;
  }

  const body = await readJsonBody(request);
  if (!body) {
    return badRequest("リクエスト形式が不正です。");
  }

  const turnMode = isTurnMode(body.turnMode) ? body.turnMode : "fixed";

  try {
    await upsertUser(auth.user);

    const session = await createSession({
      uid: auth.user.uid,
      turnMode,
      stage: "keep",
      keep: "",
      problem: "",
      memo: "",
    });

    const stored = await appendMessages({
      sessionId: session.sessionId,
      startSeq: 0,
      messages: [
        {
          role: "assistant",
          content: FIXED_MESSAGES.opening,
          stage: "keep",
          generated: false,
        },
      ],
    });

    return Response.json({
      session: toSummary(session),
      messages: stored.map(toChatMessage),
    } satisfies CreateSessionResponse);
  } catch (error) {
    return errorResponse(error, "セッションの開始に失敗しました。");
  }
}
