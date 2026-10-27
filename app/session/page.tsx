import { redirect } from "next/navigation";

/**
 * 旧 /session の受け皿。
 *
 * 対話版は既定の体験になったのでトップ（/）へ移した。
 * 予備実験の案内や手元のブックマークに /session が残っている可能性があるため、
 * 404 にせず転送する。恒久的な移動ではあるが、URL を再利用する可能性を残して
 * 308 ではなく 307（redirect）にしてある。
 */
export default function SessionRedirect() {
  redirect("/");
}
