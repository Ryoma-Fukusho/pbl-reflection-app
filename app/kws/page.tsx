import type { Metadata } from "next";

import AuthGate from "@/app/components/auth-gate";
import KwsWorkspace from "./kws-workspace";

/**
 * KWS フォーム版（統制群 / condition: "form"）。
 *
 * 既定の体験は対話版（/）で、こちらはリンクを直接指定して入る比較用の入口。
 */
export const metadata: Metadata = {
  title: "KWSフォームで振り返る | 振り返りアシスト",
};

export default function KwsPage() {
  return (
    <AuthGate>
      <KwsWorkspace />
    </AuthGate>
  );
}
