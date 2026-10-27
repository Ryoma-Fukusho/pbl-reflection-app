import "server-only";

import { ClaudeError } from "@/lib/claude";

/**
 * Route Handler 共通のエラー応答。
 *
 * 例外の詳細はサーバーログにだけ出し、クライアントには短い日本語メッセージを返す。
 * スタックトレースや内部のパスを利用者に見せないため。
 */
export function errorResponse(error: unknown, fallback: string): Response {
  if (error instanceof ClaudeError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error(fallback, error);
  return Response.json({ error: fallback }, { status: 500 });
}

export function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

export function notFound(message: string): Response {
  return Response.json({ error: message }, { status: 404 });
}

export function conflict(message: string): Response {
  return Response.json({ error: message }, { status: 409 });
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
}

export function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
