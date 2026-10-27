/**
 * クライアントとサーバーで共有する型。
 *
 * 以前は ChatMessage がフォーム版のコンポーネントと app/api/chat/route.ts に
 * 別々に（しかも違う形で）定義されていた。フィールドを増やすたびに片方だけ直して
 * ずれる事故が起きるため、ここに一本化する。
 *
 * このファイルはブラウザにも読み込まれるので server-only なものを import しないこと。
 */

/** 実験条件。form = 統制群（KWS フォーム / 旧 KPT）、dialogue = 既定の対話版 */
export type Condition = "form" | "dialogue";

export type SessionStatus = "active" | "completed" | "abandoned";

/**
 * 対話版の進め方。ゼミ内の試用で2つを比べ、導入実験でどちらを使うか決める。
 *
 * fixed    = 進め方 A。各ステージ1ターンで次へ進む（計6ターン）
 * flexible = 進め方 B。各ステージで「この話を続ける」か「次の問いへ進む」かを学習者が選ぶ。
 *            どちらの場合もステージの順序はサーバーが管理し、飛ばすことはできない
 */
export type TurnMode = "fixed" | "flexible";

export function isTurnMode(value: unknown): value is TurnMode {
  return value === "fixed" || value === "flexible";
}

/**
 * 進め方 B で1つのステージに留まれる上限ターン数。
 * これに達したら学習者の選択によらず次のステージへ進める（対話が終わらなくなるのを防ぐ）。
 */
export const MAX_TURNS_PER_STAGE = 5;

export type MessageRole = "user" | "assistant";

/**
 * AI 対話版のステージ列。コルトハーヘンの ALACT モデルに沿って固定順で進む。
 * サーバーが進行を管理するので、全参加者の問いの順序が揃う（条件統制）。
 * 進め方 A ではターン数も揃う。
 */
export const DIALOGUE_STAGES = [
  "keep",
  "problem",
  "fact",
  "feeling_other",
  "essence",
  "closing_insight",
] as const;

export type DialogueStage = (typeof DIALOGUE_STAGES)[number];

/** try_plan は「対話が終わり Try 生成に進める」ことを表す終端ステージ */
export type Stage = DialogueStage | "try_plan";

export function isDialogueStage(value: unknown): value is DialogueStage {
  return DIALOGUE_STAGES.includes(value as DialogueStage);
}

export function isStage(value: unknown): value is Stage {
  return value === "try_plan" || isDialogueStage(value);
}

/** 次のステージを返す。最後のステージ（closing_insight）の次は try_plan。 */
export function nextStage(stage: DialogueStage): Stage {
  const index = DIALOGUE_STAGES.indexOf(stage);
  const next = DIALOGUE_STAGES[index + 1];
  return next ?? "try_plan";
}

// ---------------------------------------------------------------------------
// ネットワーク上でやり取りする形（Firestore の Timestamp は ISO 文字列に変換して返す）
// ---------------------------------------------------------------------------

export type ChatMessage = {
  id: string;
  seq: number;
  role: MessageRole;
  content: string;
  /** そのメッセージがどのステージのものか。統制群では null */
  stage: Stage | null;
  /** AI が生成した本文なら true。ユーザー発言と固定文言（開始文言・締めの問い）は false */
  generated: boolean;
};

export type SessionSummary = {
  sessionId: string;
  condition: Condition;
  /** 対話版の進め方。統制群と、v3 より前のセッションでは "fixed" */
  turnMode: TurnMode;
  status: SessionStatus;
  stage: Stage | null;
  turnCount: number;
  keep: string;
  problem: string;
  memo: string;
  closingInsight: string;
  tryPlan: string;
};

// --- POST /api/sessions ---

export type CreateSessionRequest = {
  condition: Condition;
  /** 対話版のみ。省略時は "fixed" */
  turnMode?: TurnMode;
  /** 統制群のみ。フォームで先に入力された内容 */
  keep?: string;
  problem?: string;
  memo?: string;
};

export type CreateSessionResponse = {
  session: SessionSummary;
  /** 実験群では最初の問いかけが1件入る。統制群では AI の Turn 1 応答が入る */
  messages: ChatMessage[];
};

// --- POST /api/sessions/[sessionId]/messages ---

export type PostMessageRequest = {
  content: string;
  /** 入力を書き始めてから送信するまでの時間(ms)。内省にかけた時間の代理指標 */
  composeMs?: number;
  /** 常設メモの現在値。毎ターン上書き保存する */
  memo?: string;
  /**
   * 進め方 B のみ。false なら同じステージで掘り下げる問いを返す（「この話を続ける」）。
   * 省略時と進め方 A では常に次のステージへ進む
   */
  advance?: boolean;
};

export type PostMessageResponse = {
  session: SessionSummary;
  /** 今回追加された分（user 発言 + assistant 応答） */
  messages: ChatMessage[];
};

// --- POST /api/sessions/[sessionId]/complete ---

export type CompleteSessionRequest = {
  memo?: string;
};

export type CompleteSessionResponse = {
  session: SessionSummary;
  messages: ChatMessage[];
  tryPlan: string;
};

export type ApiErrorResponse = {
  error: string;
};
