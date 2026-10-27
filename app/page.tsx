import type { Metadata } from "next";

import AuthGate from "@/app/components/auth-gate";
import DialogueWorkspace from "./dialogue-workspace";

/**
 * トップページ＝対話版（コルトハーヘンの ALACT モデルに沿った6ステージ対話）。
 *
 * これが本システムの既定の振り返り体験。統制群の KWS フォーム版は /kws にある。
 */
export const metadata: Metadata = {
  title: "AI対話で振り返る | 振り返りアシスト",
};

export default function Home() {
  return (
    <AuthGate>
      <DialogueWorkspace />
    </AuthGate>
  );
}
