// Claude API の疎通確認。アプリを起動せずに「キーが通るか」「何秒かかるか」「いくらか」だけ見る。
// 実行: node <このファイル>   （プロジェクト直下から）
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";

// .env.local から Claude 関連だけ読む（Next.js を起動せずに使うため）
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && /^(ANTHROPIC_API_KEY|CLAUDE_MODEL|CLAUDE_EFFORT)$/.test(m[1])) {
    process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY が .env.local に入っていません。");
  process.exit(1);
}

const model = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const effort = process.env.CLAUDE_EFFORT || "medium";
// Sonnet 5 の料金（$/1Mトークン）。他モデルに変えたら実費とずれる
const PRICE = { in: 2.0, out: 10.0 };

const client = new Anthropic({ timeout: 50_000, maxRetries: 1 });
const startedAt = Date.now();

// lib/claude.ts と同じ呼び出し形（ストリーミング＋adaptive thinking＋effort）
const stream = client.messages.stream({
  model,
  max_tokens: 8000,
  system:
    "あなたは大学の PBL 授業で学生の振り返りを支援する対話パートナーです。" +
    "問いは必ず1つだけ、日本語で、2文以内で返します。",
  messages: [
    {
      role: "user",
      content:
        "チーム開発で、自分は実装を担当したがメンバーとの認識合わせが甘く手戻りが出ました。",
    },
  ],
  thinking: { type: "adaptive" },
  output_config: { effort },
});

const message = await stream.finalMessage();
const latencyMs = Date.now() - startedAt;
const u = message.usage;
const cost = (u.input_tokens / 1e6) * PRICE.in + (u.output_tokens / 1e6) * PRICE.out;

console.log("--- 応答 ---");
console.log(message.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
console.log("\n--- メタ情報 ---");
console.log(`model        : ${message.model}`);
console.log(`effort       : ${effort}`);
console.log(`stop_reason  : ${message.stop_reason}`);
console.log(`latency      : ${(latencyMs / 1000).toFixed(1)} 秒`);
console.log(`tokens       : in ${u.input_tokens} / out ${u.output_tokens}`);
console.log(`概算費用     : $${cost.toFixed(5)}（1往復あたり / Sonnet 5 の料金で計算）`);
