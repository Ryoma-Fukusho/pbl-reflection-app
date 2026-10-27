import "server-only";

import Anthropic from "@anthropic-ai/sdk";

/**
 * Claude API（Anthropic 公式 SDK）の薄いラッパ。
 *
 * 研究データとして必要なメタ情報（レイテンシ・使用モデル・トークン数・終了理由）を
 * 応答と一緒に返すのが主な役目。これらはサーバー側でしか取れないため、
 * 「サーバー経由で保存する」設計にしたことで初めて記録できるようになった。
 *
 * 呼び出し側（lib/conversation.ts）はこのモジュールの型だけを見ればよく、
 * SDK の型やリクエストの形はここに閉じ込める。
 */

export type ClaudeTurn = {
  /** Claude では AI 側の role は "model" ではなく "assistant" */
  role: "user" | "assistant";
  text: string;
};

/**
 * トークン使用量。Gemini の promptTokenCount / candidatesTokenCount にあたるものが
 * Claude では input_tokens / output_tokens。合計は API から返らないので自分で足す。
 *
 * cache* は今は常に 0 か null になる（プロンプトキャッシュを使っていないため）。
 * 1回の対話が短くキャッシュの最小長に届かないので、有効にしても課金が減らない。
 * 記録だけしておけば、あとで有効にしたときに効いているか確認できる。
 */
export type TokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
};

export type ClaudeResult = {
  text: string;
  latencyMs: number;
  model: string;
  /** Claude の stop_reason（end_turn / max_tokens / refusal など） */
  finishReason: string | null;
  usage: TokenUsage;
};

export class ClaudeError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = "ClaudeError";
    this.status = status;
  }
}

/**
 * 出力の深さ（思考にどれだけトークンを使うか）。
 *
 * Gemini 版では temperature 0.2 で「振れ幅を抑える」方向に統制していたが、
 * Claude Sonnet 5 / Opus 5 では temperature 自体が廃止され、送ると 400 になる。
 * 生成量を制御するレバーが effort に置き換わったので、記録する統制パラメータも
 * temperature ではなく effort にする（lib/repository.ts が sessions に書く）。
 */
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type Effort = (typeof EFFORT_LEVELS)[number];

/**
 * 1応答あたりの上限トークン数。
 *
 * 生成物は「問い1つ」か短い Try なので大きな枠は要らない。
 * ここを絞ることが、思考が暴走したときに Vercel の 60 秒
 * （各 Route Handler の maxDuration）を超える前に止まる保険になっている。
 */
const MAX_TOKENS = 8000;

/** Vercel の 60 秒より手前で自分から諦め、日本語のエラーを返せるようにする */
const REQUEST_TIMEOUT_MS = 50_000;

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ClaudeError("ANTHROPIC_API_KEY が未設定です。", 500);
  }

  // SDK のクライアントは使い回して良い（内部で fetch を張り替えたりしない）。
  // 毎回 new すると接続の再利用が効かず、レイテンシ計測にノイズが乗る。
  client ??= new Anthropic({
    // apiKey は既定で ANTHROPIC_API_KEY から読まれる
    timeout: REQUEST_TIMEOUT_MS,
    // 既定は 2。60 秒の枠内に収めたいので 1 回だけ再試行する
    maxRetries: 1,
  });

  return client;
}

export function getModelName(): string {
  // 既定は Sonnet 5（docs/claude-api-cost.html の費用見積もりに合わせた選定）。
  // 応答品質を比較したいときは CLAUDE_MODEL=claude-opus-5 で切り替える。
  return process.env.CLAUDE_MODEL || "claude-sonnet-5";
}

export function getEffort(): Effort {
  const value = process.env.CLAUDE_EFFORT;
  return EFFORT_LEVELS.includes(value as Effort) ? (value as Effort) : "medium";
}

/**
 * 応答本文を取り出す。
 *
 * content は text 以外のブロック（thinking など）も含む配列なので、
 * type で絞ってから連結する。thinking ブロックの中身は既定で空文字が入るだけで、
 * 参加者に見せるものでもないため保存しない。
 */
function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function toUsage(usage: Anthropic.Usage): TokenUsage {
  const inputTokens = usage.input_tokens ?? null;
  const outputTokens = usage.output_tokens ?? null;

  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? null,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? null,
  };
}

/**
 * SDK の例外を、そのまま参加者に見せてよい日本語のエラーに置き換える。
 *
 * 例外の中身（リクエスト ID・内部パス・APIキーの一部）はサーバーログにだけ出す。
 */
function toClaudeError(error: unknown): ClaudeError {
  if (error instanceof Anthropic.AuthenticationError) {
    console.error("Claude auth error", error.message);
    return new ClaudeError("Claude API の認証に失敗しました。APIキーを確認してください。", 500);
  }

  if (error instanceof Anthropic.RateLimitError) {
    console.error("Claude rate limited", error.message);
    return new ClaudeError("Claude API が混み合っています。少し待ってから再度お試しください。", 429);
  }

  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    console.error("Claude request timed out", error.message);
    return new ClaudeError("Claude API の応答に時間がかかりすぎました。もう一度お試しください。", 504);
  }

  if (error instanceof Anthropic.APIConnectionError) {
    console.error("Claude connection failed", error.message);
    return new ClaudeError("Claude API に接続できませんでした。");
  }

  if (error instanceof Anthropic.APIError) {
    console.error("Claude API error", error.status, error.message);
    return new ClaudeError("Claude API の呼び出しに失敗しました。");
  }

  console.error("Claude unexpected error", error);
  return new ClaudeError("Claude API の呼び出しに失敗しました。");
}

export async function generateText(params: {
  systemInstruction: string;
  turns: ClaudeTurn[];
}): Promise<ClaudeResult> {
  const anthropic = getClient();
  const model = getModelName();

  // 空文字のテキストブロックは API に拒否される。
  // Firestore 側の欠損でここまで空が流れてきても落ちないように弾いておく。
  const messages: Anthropic.MessageParam[] = params.turns
    .filter((turn) => turn.text.trim() !== "")
    .map((turn) => ({ role: turn.role, content: turn.text }));

  if (messages.length === 0) {
    throw new ClaudeError("Claude API に渡す会話が空です。", 500);
  }

  const startedAt = Date.now();

  let message: Anthropic.Message;
  try {
    // ストリーミングで受ける。画面には一括で出すが、
    // 接続を張りっぱなしにできるので長い生成でも HTTP のタイムアウトに当たらない。
    const stream = anthropic.messages.stream({
      model,
      max_tokens: MAX_TOKENS,
      system: params.systemInstruction,
      messages,
      // 適応的思考。budget_tokens は Sonnet 5 / Opus 5 では廃止されている
      thinking: { type: "adaptive" },
      output_config: { effort: getEffort() },
    });

    message = await stream.finalMessage();
  } catch (error) {
    throw toClaudeError(error);
  }

  const latencyMs = Date.now() - startedAt;
  const finishReason = message.stop_reason;

  // 安全性の判断で生成を断られた場合。HTTP は 200 で返ってくるので
  // 例外にはならず、stop_reason を見ないと気づけない。
  if (finishReason === "refusal") {
    console.error("Claude refused", message.stop_details);
    throw new ClaudeError(
      "安全性の判断により応答が生成されませんでした。表現を変えてお試しください。"
    );
  }

  const text = extractText(message);
  if (!text) {
    throw new ClaudeError("Claude API から空の応答が返されました。");
  }

  return {
    text,
    latencyMs,
    // 応答が名乗ったモデル名を記録する。要求した名前とは別物になりうる
    model: message.model || model,
    finishReason,
    usage: toUsage(message.usage),
  };
}
