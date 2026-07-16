import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

type ChatRole = "user" | "assistant";

type ChatMessage = {
  role: ChatRole;
  content: string;
};

type RequestBody = {
  mode?: "turn" | "final";
  turn?: number;
  keep?: string;
  problem?: string;
  memo?: string;
  messages?: unknown;
};

type GeminiContent = {
  role: "user" | "model";
  parts: Array<{ text: string }>;
};

const COMMON_SYSTEM = [
  "あなたは評価者や指導者ではなく、PBLを行う学生の深い内省を引き出す優れたファシリテーターです。",
  "学生に具体的な解決策やアドバイスを絶対に教えないこと。",
  "相手を否定せず、共感的で受容的なトーンを保つこと。",
].join(" ");

const TURN_1 = [
  "Turn 1 です。学生の苦労に共感を示した上で、事実や自身の感情を確認する質問を1つだけ返してください。",
  "例: その時、あなたは具体的にどのように動きましたか？",
].join(" ");

const TURN_2 = [
  "Turn 2 です。相手の視点や感情に気づかせる質問を1つだけ返してください。",
  "例: 相手から見ると、あなたの行動はどう映っていたと思いますか？",
].join(" ");

const TURN_3_PLUS = [
  "Turn 3 以降です。次に向かうための欲求や意思を引き出す質問を1つだけ返してください。",
  "例: 本当は、あなたはその状況でどうしたかったのでしょうか？",
].join(" ");

const FINAL_SYSTEM = [
  COMMON_SYSTEM,
  "Turn FINAL です。ユーザーからのチャット履歴とメモ欄の内容を統合し、次回のPBLで本人が意識すべき具体的な行動計画（Try）を箇条書きで出力してください。",
  "解決策の一般論ではなく、本人が実際に使える行動に落とし込んでください。",
].join(" ");

function isChatMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as ChatMessage;
  return (candidate.role === "user" || candidate.role === "assistant") && typeof candidate.content === "string";
}

function buildSystemInstruction(mode: "turn" | "final", turn: number, keep: string, problem: string, memo: string) {
  if (mode === "final") {
    return [
      FINAL_SYSTEM,
      `Keep: ${keep || "未入力"}`,
      `Problem: ${problem || "未入力"}`,
      `Memo: ${memo || "未入力"}`,
    ].join("\n");
  }

  const turnInstruction = turn <= 1 ? TURN_1 : turn === 2 ? TURN_2 : TURN_3_PLUS;
  return [
    COMMON_SYSTEM,
    turnInstruction,
    `現在の Keep: ${keep || "未入力"}`,
    `現在の Problem: ${problem || "未入力"}`,
  ].join("\n");
}

function toGeminiContents(messages: ChatMessage[]): GeminiContent[] {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));
}

function buildContextContent(keep: string, problem: string, memo: string) {
  return {
    role: "user" as const,
    parts: [
      {
        text: [
          "以下は振り返りの前提文脈です。以後の応答は必ずこの文脈を踏まえてください。",
          `Keep: ${keep || "未入力"}`,
          `Problem: ${problem || "未入力"}`,
          `Memo: ${memo || "未入力"}`,
        ].join("\n"),
      },
    ],
  };
}

function extractTextFromResponse(data: unknown) {
  const response = data as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  return response.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() ?? "";
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  if (!apiKey) {
    return Response.json({ error: "GEMINI_API_KEY が未設定です。" }, { status: 500 });
  }

  const body = (await request.json().catch(() => null)) as RequestBody | null;
  if (!body || (body.mode !== "turn" && body.mode !== "final")) {
    return Response.json({ error: "リクエスト形式が不正です。" }, { status: 400 });
  }

  const messages = Array.isArray(body.messages) ? body.messages.filter(isChatMessage) : [];
  const keep = typeof body.keep === "string" ? body.keep.trim() : "";
  const problem = typeof body.problem === "string" ? body.problem.trim() : "";
  const memo = typeof body.memo === "string" ? body.memo.trim() : "";
  const turn = typeof body.turn === "number" ? body.turn : 1;

  const systemInstruction = buildSystemInstruction(body.mode, turn, keep, problem, memo);
  const contents: GeminiContent[] =
    body.mode === "final"
      ? [
          buildContextContent(keep, problem, memo),
          ...toGeminiContents(messages),
          {
            role: "user",
            parts: [
              {
                text: [
                  "これまでのチャット履歴とメモを踏まえて、次回のPBLで意識する Try を箇条書きで整理してください。",
                  "Keep と Problem の文脈を優先し、本人が実際に取れる行動に落とし込んでください。",
                ].join("\n"),
              },
            ],
          },
        ]
      : [buildContextContent(keep, problem, memo), ...toGeminiContents(messages)];

  try {
    const geminiResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemInstruction }],
        },
        contents,
      generationConfig: {
          temperature: 0.2,
        },
      }),
    });

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      console.error("Gemini API error", geminiResponse.status, errorText);
      return Response.json({ error: "Gemini API の呼び出しに失敗しました。" }, { status: 502 });
    }

    const data = (await geminiResponse.json()) as unknown;
    const message = extractTextFromResponse(data);

    if (!message) {
      return Response.json({ error: "Gemini API から空の応答が返されました。" }, { status: 502 });
    }

    return Response.json({ message });
  } catch (error) {
    console.error("Unexpected chat route error", error);
    return Response.json({ error: "AI 応答の生成中に予期しないエラーが発生しました。" }, { status: 500 });
  }
}

