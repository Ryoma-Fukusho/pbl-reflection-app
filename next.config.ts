import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * 開発用インジケータ（画面左下に出る丸いバッジ）を消す。
   * 論文の図として画面を撮るときに毎回写り込むため。
   * 非表示にしてもコンパイルエラー・実行時エラーの表示は残る。
   */
  devIndicators: false,
};

export default nextConfig;
