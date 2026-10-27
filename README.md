# 振り返りアシスト

PBL の個人の振り返りを、LLM との対話で支援する Web システム（卒業研究）。

- [docs/design.md](docs/design.md): システムの構成、データモデル、セットアップ
- [docs/prompt-design.md](docs/prompt-design.md): プロンプトの設計
- [docs/todo.md](docs/todo.md): 残っている作業
- [docs/history.md](docs/history.md): ここまでの経緯

```bash
npm install
npm run dev     # http://localhost:3000/ （判断も見るなら /?debug=1）
```

`.env.local` が必要。項目は [.env.example](.env.example)、取得方法は [docs/design.md](docs/design.md) §5。
