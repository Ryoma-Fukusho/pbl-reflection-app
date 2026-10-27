import type { Metadata } from "next";

import AuthGate from "@/app/components/auth-gate";
import DialogueWorkspace from "./dialogue-workspace";

/** トップページ。コルトハーヘンの ALACT モデルに沿ったステージで進む対話版。 */
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
