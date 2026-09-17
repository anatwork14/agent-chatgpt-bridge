# Agent ChatGPT Bridge

外部 AI Agent が主 Agent のまま、ユーザーがログイン済みの ChatGPT Web セッションとプログラム的に協調できるローカルブリッジです。

本プロジェクトは [`miuuyy/codex-chatgpt-web`](https://github.com/miuuyy/codex-chatgpt-web) を基盤にしています。上流の Codex 統合を維持しつつ、プロトコル非依存セッション、REST、MCP、専用 CLI、永続化、そして境界付きの Agent ↔ ChatGPT 自動リレーを追加します。

> **状態:** 1.0 前の検証段階です。コア動作はリポジトリのテストスイートとクロスプラットフォーム CI で検証されています。正式リリース前には、実際にサインインした ChatGPT セッションでアカウント依存のブラウザ動作を確認する必要があります。

## このプロジェクトでできること

```text
Codex / Claude Code / Gemini CLI / OpenCode / Aider / custom agent
                              │
                    REST / MCP / CLI / JSONL
                              │
                              ▼
                  Agent ChatGPT Bridge
                  ├─ Session Manager
                  ├─ Turn Manager
                  ├─ SQLite persistence
                  ├─ Run Controller
                  ├─ Security / permissions
                  └─ protocol adapters
                              │
                              ▼
              ChatGPTWebConversationProvider
                              │
                              ▼
         upstream codex-chatgpt-web browser runtime
                              │
                              ▼
                         ChatGPT Web
```

外部 Agent は、推論、コーディング、実験、および作業完了の判断を引き続き担当します。ChatGPT Web は協働相手、レビュアー、研究者、批評者、またはサブ Agent であり、外部 Agent を暗黙に置き換えるバックエンドではありません。

## 実装済みのインターフェース

- ChatGPT の会話 ID を分離した永続 Bridge セッション。
- セッション、メッセージ、モデル、MCP、自動実行を扱う `agent-chatgpt` CLI。
- `/bridge/v1` 配下のローカル REST API。SSE ストリーミングと Bearer Token 保護を含みます。
- Agent → ChatGPT 通信用 MCP ツール。
- 汎用外部 Agent 向けの厳密な subprocess JSONL アダプター。
- sessions、messages、turns、runs、idempotency、audit records の SQLite 永続化。
- ラウンド数、壁時計時間、連続失敗数、キャンセルを制限した境界付き自動協働。
- 上流ルーティング実装を使ったアカウント対応 ChatGPT Web モデル検出。
- UI ドリフト、終端証拠不足、不正なプロトコルフレーム、利用不能モデルで fail closed。
- 既存の `codex-chatgpt-web` CLI と `/v1/responses` 互換経路を維持。

## セキュリティ境界

- ChatGPT の出力は信頼できないテキストとして扱い、shell コマンド実行やファイル変更を直接許可しません。
- ログインは launcher 管理ブラウザ内で手動のままです。Bridge はパスワード入力、CAPTCHA 回避、Cookie インポートを自動化しません。
- Bridge は既定で loopback のみに bind します。
- ネイティブ Bridge ルートは既存のプライベートな runtime control secret から導出されたローカル Bearer Token を要求します。
- 自動ループは有界でキャンセル可能です。
- サイレントなモデルフォールバックや利用制限回避は行いません。

ツール対応または full-harness ワークフローを有効にする前に [`docs/security-model.md`](docs/security-model.md) を読んでください。

## 開発セットアップ

ソースランタイムには Bun 1.4.0 が必要です。

要件:

- Bun 1.4.0
- 上流プロジェクト由来の既存 ChatGPT Web launcher/browser セットアップ
- ライブブラウザ検証用のログイン済み ChatGPT セッション

```bash
git clone https://github.com/anatwork14/agent-chatgpt-bridge.git
cd agent-chatgpt-bridge
bun install --frozen-lockfile
bun run typecheck
bun test
```

ブラウザ認証の所有者は引き続き上流 launcher です。ソースから利用する場合、ライブ Bridge turn の前に既存 launcher/setup フローでログインし、ブラウザ面を検証してください。

## Bridge CLI

ソース開発中は、以下の `agent-chatgpt` を `bun src/cli/index.ts` に置き換えられます。

汎用 Bridge daemon を開始:

```bash
agent-chatgpt serve
```

既定の Bridge endpoint:

```text
http://127.0.0.1:8765/bridge/v1
```

永続セッションを作成して継続:

```bash
agent-chatgpt session create --name demo
agent-chatgpt ask --session demo "Remember the number 8427."
agent-chatgpt ask --session demo "What number did I ask you to remember?"
```

状態を確認:

```bash
agent-chatgpt status --json
agent-chatgpt models --json
agent-chatgpt session list --json
agent-chatgpt session transcript demo --json
```

別コマンドから内容を pipe:

```bash
git diff | agent-chatgpt ask --session code-review --stdin
```

## MCP

Agent → ChatGPT MCP server を起動:

```bash
agent-chatgpt mcp
```

利用可能なツール:

```text
chatgpt_create_session
chatgpt_ask
chatgpt_continue
chatgpt_get_session
chatgpt_list_sessions
chatgpt_list_models
chatgpt_cancel
chatgpt_close_session
```

[`docs/MCP.md`](docs/MCP.md) を参照してください。

## 自動 Relay

汎用外部 Agent は厳密な subprocess JSONL プロトコル経由で参加できます。

```bash
agent-chatgpt run \
  --objective "Find and fix the parser race" \
  --agent-command ./my-agent-wrapper \
  --max-rounds 20
```

各外部 Agent 呼び出しでは、stdin にバージョン付き JSON を 1 行だけ渡し、stdout には有効な decision frame を正確に 1 つだけ返す必要があります。人間向けログは stderr に出力します。

[`docs/agent-adapters.md`](docs/agent-adapters.md) を参照してください。

## REST API

ネイティブ API は `/bridge/v1` 配下で versioning され、sessions、transcripts、models、cancellation、collaboration runs を提供します。ストリーミング turn は SSE を使用します。

[`docs/API.md`](docs/API.md) を参照してください。

## Codex 互換性

このリポジトリは上流の製品経路を意図的に保持します。

```text
Codex → /v1/responses → codex-chatgpt-web → ChatGPT Web
```

元の `codex-chatgpt-web` CLI、browser worker、launcher、model routing、compaction、Codex harness は互換インフラとして残ります。汎用 Bridge はその runtime を書き直さずラップします。

## 検証

```bash
bun run typecheck
bun test
bun run verify
bun run app:package
bun run app:smoke
```

CI は macOS、Linux、Windows で検証を行います。ライブブラウザ検証には実際のログイン済み ChatGPT アカウントが必要なため、意図的に別工程にしています。

必須のライブマイルストーン:

```bash
agent-chatgpt session create --name demo
agent-chatgpt ask --session demo "Remember 8427."
agent-chatgpt ask --session demo "What value did I ask you to remember?"
```

最後の応答には、人手によるメッセージのコピーなしで `8427` が含まれる必要があります。その後、2 セッションの分離、キャンセル、MCP ask/continue、2 ラウンド以上の自動 relay を検証します。

[`docs/release-validation-agent-bridge.md`](docs/release-validation-agent-bridge.md) を参照してください。

## アーキテクチャと実装

- [`implementation.md`](implementation.md) — 正式な実装仕様
- [`docs/architecture.md`](docs/architecture.md) — アーキテクチャ背景
- [`docs/API.md`](docs/API.md) — ネイティブ REST 契約
- [`docs/MCP.md`](docs/MCP.md) — Agent → ChatGPT MCP インターフェース
- [`docs/agent-adapters.md`](docs/agent-adapters.md) — 外部 Agent プロトコル
- [`docs/security-model.md`](docs/security-model.md) — trust boundary とセキュリティ
- [`docs/development.md`](docs/development.md) — contributor workflow
- [`docs/upstream-patches.md`](docs/upstream-patches.md) — upstream 同期メモ
- [`IMPLEMENTATION_PROGRESS.md`](IMPLEMENTATION_PROGRESS.md) — 証拠に基づく現在状況

## License

MIT。継承した上流コードには元のライセンス表記が引き続き適用されます。
