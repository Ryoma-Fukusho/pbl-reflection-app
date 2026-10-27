import type { NextRequest } from "next/server";

import { authenticateRequest, upsertUser } from "@/lib/auth";
import { generateFormReply } from "@/lib/conversation";
import { FIXED_MESSAGES } from "@/lib/prompts";
import {
  appendMessages,
  createSession,
  toChatMessage,
  toSummary,
  type MessageInput,
} from "@/lib/repository";
import { badRequest, errorResponse, readJsonBody, readString } from "@/lib/route-utils";
import { isTurnMode, type CreateSessionResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 振り返りセッションを開始する。
 *
 * dialogue（実験群）: 固定の問いかけ1件だけを置いて返す。
 *   まだ学生の発言が無いので AI に生成させる材料が無く、また
 *   全参加者の入り口を揃えたいので固定文言にしている。
 *
 * form（統制群）: フォームで入力済みの Keep/Problem を最初のユーザー発話として
 *   記録し、従来どおり Turn 1 の問いを AI に生成させる。
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

  const condition = body.condition === "dialogue" ? "dialogue" : "form";
  const turnMode = condition === "dialogue" && isTurnMode(body.turnMode) ? body.turnMode : "fixed";
  const keep = readString(body.keep);
  const problem = readString(body.problem);
  const memo = readString(body.memo);

  if (condition === "form" && !problem) {
    return badRequest("問題点・モヤモヤを入力してください。");
  }

  try {
    await upsertUser(auth.user);

    if (condition === "dialogue") {
      const session = await createSession({
        uid: auth.user.uid,
        condition: "dialogue",
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
    }

    const session = await createSession({
      uid: auth.user.uid,
      condition: "form",
      turnMode: "fixed",
      stage: null,
      keep,
      problem,
      memo,
    });

    const kickoff: MessageInput = {
      role: "user",
      content: `Keep: ${keep || "未入力"}\nProblem: ${problem}`,
      stage: null,
      generated: false,
    };

    const reply = await generateFormReply(session, [kickoff], 1);

    const stored = await appendMessages({
      sessionId: session.sessionId,
      startSeq: 0,
      messages: [kickoff, reply],
      sessionPatch: { turnCount: 1 },
    });

    return Response.json({
      session: { ...toSummary(session), turnCount: 1 },
      messages: stored.map(toChatMessage),
    } satisfies CreateSessionResponse);
  } catch (error) {
    return errorResponse(error, "セッションの開始に失敗しました。");
  }
}
