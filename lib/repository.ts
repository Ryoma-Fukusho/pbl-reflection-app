import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { getDb } from "@/lib/firebase/admin";
import { getEffort, getModelName, type TokenUsage } from "@/lib/claude";
import { PROMPT_VERSION, type Facilitation } from "@/lib/prompts";
import type {
  ChatMessage,
  Condition,
  MessageRole,
  SessionStatus,
  SessionSummary,
  Stage,
  TurnMode,
} from "@/lib/types";

/**
 * Firestore へのアクセスをここに閉じ込める。
 *
 * データモデル:
 *   users/{uid}                         個人情報はここだけ（lib/auth.ts が書く）
 *   sessions/{sessionId}                振り返り1回分。uid のみ持ち個人情報は持たない
 *   sessions/{sessionId}/messages/{id}  発話1件。サブコレクションにしている
 *
 * なぜ messages をサブコレクションにするか:
 *   Firestore は1ドキュメント最大1MB。会話を配列で1ドキュメントに詰めると、
 *   長い対話でいずれ破綻するうえ、1発話追加するたびに全体を読み書きすることになる。
 *   サブコレクションなら追記は1件の書き込みで済む。
 */

/** どのコード版で収集したデータかを追えるようにする。Vercel では自動で入る。 */
const APP_VERSION = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev";

export type SessionRecord = {
  sessionId: string;
  uid: string;
  condition: Condition;
  turnMode: TurnMode;
  status: SessionStatus;
  stage: Stage | null;
  keep: string;
  problem: string;
  memo: string;
  closingInsight: string;
  tryPlan: string;
  turnCount: number;
  messageCount: number;
  startedAt: Date | null;
};

export type MessageInput = {
  role: MessageRole;
  content: string;
  stage: Stage | null;
  /** assistant のうち AI 生成なら true、固定文言なら false */
  generated: boolean;
  /** user のみ: 入力を書き始めてから送信するまでの時間 */
  composeMs?: number;
  /**
   * user のみ・進め方 B のみ: 学習者が押したボタン。continue =「この話を続ける」、advance =「次の問いへ進む」。
   * 上限ターン数で次へ進めた場合も、押したボタンをそのまま残す（実際の進行は次の発話の stage で分かる）
   */
  choice?: "continue" | "advance";
  /** assistant のみ・進め方 B のみ: この問いを出す前のファシリテーターの判断と、その呼び出しのメタ情報 */
  facilitation?: Facilitation & { latencyMs: number; usage: TokenUsage };
  /** assistant のみ: 学習者が答えずに（空欄のまま）次のステージへ進んだ直後の問いなら true */
  skipped?: boolean;
  /** assistant のみ: Claude 呼び出しのメタ情報 */
  latencyMs?: number;
  model?: string;
  promptVersion?: string;
  finishReason?: string | null;
  usage?: TokenUsage;
};

export type StoredMessage = MessageInput & { id: string; seq: number };

function sessionsRef() {
  return getDb().collection("sessions");
}

function messagesRef(sessionId: string) {
  return sessionsRef().doc(sessionId).collection("messages");
}

function toDate(value: unknown): Date | null {
  return value instanceof Timestamp ? value.toDate() : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function toSummary(record: SessionRecord): SessionSummary {
  return {
    sessionId: record.sessionId,
    condition: record.condition,
    turnMode: record.turnMode,
    status: record.status,
    stage: record.stage,
    turnCount: record.turnCount,
    keep: record.keep,
    problem: record.problem,
    memo: record.memo,
    closingInsight: record.closingInsight,
    tryPlan: record.tryPlan,
  };
}

export function toChatMessage(message: StoredMessage): ChatMessage {
  return {
    id: message.id,
    seq: message.seq,
    role: message.role,
    content: message.content,
    stage: message.stage,
    generated: message.generated,
    facilitation: message.facilitation
      ? {
          focus: message.facilitation.focus,
          covered: message.facilitation.covered,
          nextItem: message.facilitation.next_item,
          stageDone: message.facilitation.stage_done,
          flow: message.facilitation.flow,
          reason: message.facilitation.reason,
        }
      : undefined,
  };
}

export async function createSession(params: {
  uid: string;
  condition: Condition;
  turnMode: TurnMode;
  stage: Stage | null;
  keep: string;
  problem: string;
  memo: string;
}): Promise<SessionRecord> {
  const ref = sessionsRef().doc();

  await ref.set({
    uid: params.uid,
    condition: params.condition,
    turnMode: params.turnMode,
    status: "active" satisfies SessionStatus,
    stage: params.stage,

    // 再現性のための記録。あとからプロンプトやモデルを変えても、
    // 各セッションがどの条件で収集されたか特定できる。
    promptVersion: PROMPT_VERSION,
    appVersion: APP_VERSION,
    model: getModelName(),
    effort: getEffort(),

    keep: params.keep,
    problem: params.problem,
    memo: params.memo,
    closingInsight: "",
    tryPlan: "",

    turnCount: 0,
    messageCount: 0,

    // 集計の生値。平均ではなく合計と件数で持つ。
    // 平均だけ保存すると後から別の集計ができなくなるため。
    metrics: {
      totalUserChars: 0,
      totalAssistantChars: 0,
      latencySumMs: 0,
      aiResponseCount: 0,
    },

    // クライアントの時計は信用しない。ズレが所要時間の測定を汚染する。
    startedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    completedAt: null,
  });

  const snapshot = await ref.get();
  return toRecord(ref.id, snapshot.data());
}

function toRecord(sessionId: string, data: FirebaseFirestore.DocumentData | undefined): SessionRecord {
  return {
    sessionId,
    uid: text(data?.uid),
    condition: data?.condition === "dialogue" ? "dialogue" : "form",
    // v3 より前のセッションには turnMode が無い。当時は全て1ステージ1ターンだった
    turnMode: data?.turnMode === "flexible" ? "flexible" : "fixed",
    status: (data?.status as SessionStatus) ?? "active",
    stage: (data?.stage as Stage | null) ?? null,
    keep: text(data?.keep),
    problem: text(data?.problem),
    memo: text(data?.memo),
    closingInsight: text(data?.closingInsight),
    tryPlan: text(data?.tryPlan),
    turnCount: typeof data?.turnCount === "number" ? data.turnCount : 0,
    messageCount: typeof data?.messageCount === "number" ? data.messageCount : 0,
    startedAt: toDate(data?.startedAt),
  };
}

/**
 * セッションを取得する。
 *
 * 重要: Admin SDK はセキュリティルールをバイパスするので、
 * 「他人のセッションを触れないこと」はここのコードだけが担保している。
 * uid の一致を確認せずに sessionId だけで読み書きすると、
 * ID を推測した第三者が他人の対話ログを読めてしまう。
 */
export async function getOwnedSession(sessionId: string, uid: string): Promise<SessionRecord | null> {
  const snapshot = await sessionsRef().doc(sessionId).get();
  if (!snapshot.exists) {
    return null;
  }

  const record = toRecord(snapshot.id, snapshot.data());
  return record.uid === uid ? record : null;
}

export async function getMessages(sessionId: string): Promise<StoredMessage[]> {
  // Firestore は挿入順を保証しないため、明示的な seq で並べる。
  const snapshot = await messagesRef(sessionId).orderBy("seq", "asc").get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      seq: typeof data.seq === "number" ? data.seq : 0,
      role: data.role === "assistant" ? "assistant" : "user",
      content: text(data.content),
      stage: (data.stage as Stage | null) ?? null,
      generated: data.generated !== false,
      composeMs: typeof data.composeMs === "number" ? data.composeMs : undefined,
      latencyMs: typeof data.latencyMs === "number" ? data.latencyMs : undefined,
    };
  });
}

/**
 * 発話を追記し、同時にセッションを更新する。
 *
 * WriteBatch で1回にまとめているので、「AI の応答は保存されたがセッションの
 * ステージが進んでいない」といった中途半端な状態が残らない。
 *
 * @param startSeq 既存メッセージ数。呼び出し側は履歴を読んでいるのでその length を渡す。
 */
export async function appendMessages(params: {
  sessionId: string;
  startSeq: number;
  messages: MessageInput[];
  sessionPatch?: Record<string, unknown>;
}): Promise<StoredMessage[]> {
  const db = getDb();
  const batch = db.batch();
  const sessionDoc = sessionsRef().doc(params.sessionId);

  const stored: StoredMessage[] = [];

  let userChars = 0;
  let assistantChars = 0;
  let latencySum = 0;
  let aiResponses = 0;

  params.messages.forEach((message, index) => {
    const seq = params.startSeq + index;
    const ref = messagesRef(params.sessionId).doc();

    batch.set(ref, {
      seq,
      role: message.role,
      content: message.content,
      charCount: message.content.length,
      stage: message.stage,
      generated: message.generated,
      composeMs: message.composeMs,
      choice: message.choice,
      facilitation: message.facilitation,
      skipped: message.skipped,
      latencyMs: message.latencyMs,
      model: message.model,
      promptVersion: message.promptVersion,
      finishReason: message.finishReason,
      usage: message.usage,
      createdAt: FieldValue.serverTimestamp(),
    });

    if (message.role === "user") {
      userChars += message.content.length;
    } else {
      assistantChars += message.content.length;
      if (typeof message.latencyMs === "number") {
        latencySum += message.latencyMs;
        aiResponses += 1;
      }
    }

    stored.push({ ...message, id: ref.id, seq });
  });

  batch.update(sessionDoc, {
    ...params.sessionPatch,
    messageCount: FieldValue.increment(params.messages.length),
    "metrics.totalUserChars": FieldValue.increment(userChars),
    "metrics.totalAssistantChars": FieldValue.increment(assistantChars),
    "metrics.latencySumMs": FieldValue.increment(latencySum),
    "metrics.aiResponseCount": FieldValue.increment(aiResponses),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return stored;
}

/** セッションを完了状態にする。所要時間はサーバー時刻どうしの差で確定させる。 */
export function completionPatch(startedAt: Date | null) {
  return {
    status: "completed" satisfies SessionStatus,
    completedAt: FieldValue.serverTimestamp(),
    "metrics.durationMs": startedAt ? Date.now() - startedAt.getTime() : null,
  };
}

/**
 * セッションを離脱状態にする。
 *
 * これを書かないと、途中でやめたセッションが active のまま残り、
 * 「まだ続いている人」と区別がつかなくなる。
 * 離脱時点の stage はドキュメントにそのまま残るので、
 * どのステージで離脱が集中するかは後から集計できる。
 */
export async function abandonSession(sessionId: string, startedAt: Date | null): Promise<void> {
  await sessionsRef().doc(sessionId).update({
    status: "abandoned" satisfies SessionStatus,
    abandonedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    "metrics.durationMs": startedAt ? Date.now() - startedAt.getTime() : null,
  });
}
