/**
 * クライアントとサーバーで共有する型。
 *
 * 以前は ChatMessage がフォーム版のコンポーネントと app/api/chat/route.ts に
 * 別々に（しかも違う形で）定義されていた。フィールドを増やすたびに片方だけ直して
 * ずれる事故が起きるため、ここに一本化する。
 *
 * このファイルはブラウザにも読み込まれるので server-only なものを import しないこと。
 */

export type SessionStatus = "active" | "completed" | "abandoned";

/**
 * 対話版の進め方。ゼミ内の試用で2つを比べ、導入実験でどちらを使うか決める。
 *
 * fixed    = 進め方 A。各ステージ1ターンで次へ進む
 * flexible = 進め方 B。ステージを終えてよいかをファシリテーター（LLM）が判断して進める。
 *            学習者は「次の観点へ」でいつでも先へ進める。ステージの順序はサーバーが管理する
 */
export type TurnMode = "fixed" | "flexible";

export function isTurnMode(value: unknown): value is TurnMode {
  return value === "fixed" || value === "flexible";
}


export type MessageRole = "user" | "assistant";

/**
 * ステージ列。質問会議の手順（問題提示 → 問題の明確化 → 問題の再定義 → アクションプランの提示
 * → 質問会議の振り返り）に沿い、問いの観点はコルトハーヘンの ALACT モデルの第2〜4局面から決めている。
 * 第1局面（行為）と第5局面（試行）は PBL の活動そのもので、システムの外にある。
 * サーバーが進行を管理するので、全参加者の問いの順序が揃う。進め方 A ではターン数も揃う。
 *
 * problem         問題提示。開始の問いかけ（固定文言）に1回答える
 * fact            問題の明確化（自分の側）
 * feeling_other   問題の明確化（相手の側）
 * essence         本当の願い
 * closing_insight 問題の言い直し。締めの問い（固定文言）
 * action_plan     次に試すこと。本人に問う（生成）
 *
 * 質問会議の最後の「質問会議の振り返り」にあたる振り返りの振り返りは、対話の流れに入れず、
 * Try の後に任意の入力欄として置く（sessions.sessionReview）。終わりに決まった問いが続くと、
 * 会話ではなく手続きをこなしている感じになるため。
 */
export const DIALOGUE_STAGES = [
  "problem",
  "fact",
  "feeling_other",
  "essence",
  "closing_insight",
  "action_plan",
] as const;

export type DialogueStage = (typeof DIALOGUE_STAGES)[number];

/** try_plan は「対話が終わり Try の整理に進める」ことを表す終端ステージ */
export type Stage = DialogueStage | "try_plan";

/** 進め方 B でファシリテーターが判断するステージ。problem は開始の問いが固定文言だが、扱う問題の判断は行う */
export type FacilitatedStage = "problem" | "fact" | "feeling_other" | "essence";

/** LLM が問いを生成するステージ */
export type GeneratedStage = "fact" | "feeling_other" | "essence";

export function isDialogueStage(value: unknown): value is DialogueStage {
  return DIALOGUE_STAGES.includes(value as DialogueStage);
}

export function isFacilitatedStage(stage: Stage): stage is FacilitatedStage {
  return stage === "problem" || isGeneratedStage(stage);
}

export function isGeneratedStage(stage: Stage): stage is GeneratedStage {
  return stage === "fact" || stage === "feeling_other" || stage === "essence";
}

/** 次のステージを返す。最後のステージ（action_plan）の次は try_plan。 */
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
  /** そのメッセージがどのステージのものか */
  stage: Stage | null;
  /** AI が生成した本文なら true。ユーザー発言と固定文言は false */
  generated: boolean;
  /**
   * 進め方 B の assistant メッセージのみ。この問いを出す前のファシリテーターの判断。
   * 画面の「振り返りの進み方」に、扱っている問題と聞けた観点を出すのに使う
   */
  facilitation?: FacilitationView;
};

/** ファシリテーターの判断のうち、画面に送るもの */
export type FacilitationView = {
  /** 判断したときのステージ（ステージが切り替わった直後の問いでは、前のステージ） */
  judgedStage: Stage;
  /** 学習者がいま扱っている問題（一文） */
  focus: string;
  /** いま掘っている話（学習者の言葉） */
  thread: string;
  /** 話の状態・ねらいへの到達・ステージを終えたか・理由。学習者には出さず、?debug=1 のときだけ表示する */
  flow: string;
  level: string;
  stageDone: boolean;
  reason: string;
  /** その時点でのステージ内のターン数 */
  turnsInStage: number;
};

export type SessionSummary = {
  sessionId: string;
  /** 進め方。進め方を選べるようになる前のセッションでは "fixed" */
  turnMode: TurnMode;
  status: SessionStatus;
  stage: Stage | null;
  turnCount: number;
  problem: string;
  memo: string;
  closingInsight: string;
  actionPlan: string;
  sessionReview: string;
  tryPlan: string;
};

// --- POST /api/sessions ---

export type CreateSessionRequest = {
  /** 省略時は "fixed" */
  turnMode?: TurnMode;
};

export type CreateSessionResponse = {
  session: SessionSummary;
  /** 最初の問いかけ（固定文言）が1件入る */
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
   * 進め方 B の「次の観点へ」。true なら、答えずに（または答えたうえで）次のステージへ進む。
   * 省略時は、進むかどうかをファシリテーターが決める
   */
  next?: boolean;
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

// --- POST /api/sessions/[sessionId]/review ---

/** 振り返りの振り返り（任意）。Try の後に送る */
export type ReviewSessionRequest = {
  content: string;
};

export type ReviewSessionResponse = {
  session: SessionSummary;
};

export type ApiErrorResponse = {
  error: string;
};
