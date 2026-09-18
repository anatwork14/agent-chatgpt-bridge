# Agent ChatGPT Bridge

AI エージェントがメッセージを手動コピーすることなく、ChatGPT Web、ルーティングされたモデルプロバイダー、およびその他の ACP 対応エージェントと協調動作できるようにする、ローカルかつプロバイダー非依存の協調ランタイムです。

Agent Bridge は協調セマンティクスを統括します: 永続セッション、標準 transcript、キャンセル、有界ワークフロー、権限、ルーティングポリシー、永続化、および監査可能性。プロバイダー固有の認証はプロバイダーまたはローカルエージェントクライアント側に留まります。

> **ステータス (2026-09-19):** P1–P4 はリリース済み / 実環境サインオフ済みです。P5 の有界マルチ参加者協調 DAG も実装済みで、Claude + Antigravity による実環境サインオフが完了しています。リリース追跡は PR #10 / issue #9 です。

## アーキテクチャ

```text
External agents / clients
Codex / Cursor / Claude / Gemini / IDE / script
                    |
       REST / MCP / ACP / CLI / Responses
                    |
                    v
+--------------------------------------------------+
|               Agent Bridge                       |
|                                                  |
|  SessionManager       persistent sessions        |
|  canonical transcript / turn serialization       |
|  RunController        bounded collaboration      |
|  ProviderRegistry     provider/model ownership   |
|  routing policy       health/cooldown/fallback   |
|  permission boundary audit / persistence         |
+------------------------+-------------------------+
                         |
             +-----------+-----------+
             |                       |
             v                       v
 ChatGPTWebConversationProvider   CodexRouterConversationProvider
             |                       |
             v                       v
        ChatGPT Web                codex-router
                                      |
                              external providers

ExternalAgentAdapter side:

RunController
    |
    +-- JsonlSubprocessAgent
    +-- AcpAgentAdapter
            |-- Cursor: agent acp
            |-- Gemini: gemini --acp
            |-- Claude: claude-agent-acp
            `-- custom ACP agent
```

ChatGPT Web は最初の直接プロバイダーですが、アーキテクチャそのものではありません。`codex-router` は下流の `ConversationProvider` であり、Agent Bridge は常に上位の協調プレーンとして機能します。

## ARC および CompanyOS との関係

```text
CompanyOS
    |
    v
ARC ---------------- Agent Bridge
 |                       |
 |                       +-- ChatGPT Web
 |                       +-- codex-router
 |                       +-- Cursor / Claude / Gemini via ACP
 |                       `-- future providers / agents
 |
 v
tasks / experiments / recovery / evidence
```

- **ARC / adaptive-agent-runtime** は実行プレーンです: タスク DAG、分離、実験、リカバリ、台帳、ランタイム制御。
- **Agent Bridge** はインテリジェンス/協調ゲートウェイです: 会話、セッション、プロバイダールーティング、エージェント間相互作用、権限、および有界協調。
- **CompanyOS** はその上位にある連携・プロダクト層です。

## 実装されたサーフェス

- 標準 SQLite transcript を備えた永続 Bridge セッション。
- セッション分離、シリアライズ、キャンセル、中断されたターンのリカバリ、再起動時の継続性。
- セッション、メッセージ、モデル、MCP、および有界自律実行のための `agent-chatgpt` CLI。
- SSE ストリーミングと Bearer Token 保護を備えた `/bridge/v1` 配下のローカル REST API。
- Agent -> ChatGPT 連携用 MCP ツール。
- 汎用外部エージェント用の厳密な subprocess JSONL アダプター。
- 永続セッション、ストリーミング、キャンセル、権限処理、サブプロセス所有/クリーンアップ、監査イベントを備えたネイティブ ACP 外部エージェントアダプター。
- Cursor、Gemini CLI、Claude ACP 用の組み込み ACP プロファイル、およびカスタムコマンド。
- プロバイダー健全性監視: `healthy`、`unavailable`、`rate_limited`、`cooldown`、`misconfigured`。
- 明示的設定のみの順序付きフォールバックポリシー（サイレントなプロバイダー移行やターン途中のフォールバックなし）。
- 名前空間付きモデル検出と標準 Agent Bridge 履歴を備えた任意の `codex-router` プロバイダープレーン。
- ラウンド数、実行時間、連続失敗、およびキャンセル制限を備えた有界自律協調。
- 既存の上流 `codex-chatgpt-web` CLI および `/v1/responses` 互換性の維持。

## セキュリティ境界

- モデルおよびエージェントの出力は信頼できないコンテンツとして扱われ、Agent Bridge から直接シェル/ファイル権限を取得することはありません。
- ChatGPT Web へのログインはランチャー管理ブラウザ内で手動のままです。
- サブスクリプションエージェント/プロバイダーの認証は Cursor、Gemini、Claude、codex-router、または該当プロバイダー側に保持されます。Agent Bridge はその OAuth/API 認証情報を Bridge 状態にコピーしません。
- Bridge/プロバイダー制御面は既定で loopback にのみ bind します。
- ネイティブ Bridge ルートは、プライベートランタイム制御シークレットから導出されたローカル Bearer Token を要求します。
- ACP ファイルシステムおよびターミナルコールバックは既定で無効化されています。明示的に設定されない限り権限ポリシーは fail-closed です。
- 自律ループは有界でキャンセル可能です。
- サイレントなモデル/プロバイダーフォールバックや利用制限回避は行いません。
- プロトコルの曖昧さ、UI ドリフト、ターミナル証拠の欠如は fail closed です。

ツール対応ワークフローを有効にする前に [`docs/security-model.md`](docs/security-model.md) を確認してください。

## 開発セットアップ

ソースランタイムには Bun 1.4.0 が必要です。

```bash
git clone https://github.com/anatwork14/agent-chatgpt-bridge.git
cd agent-chatgpt-bridge
bun install --frozen-lockfile
bun run typecheck
bun test
bun run verify
```

サインイン済みの ChatGPT ブラウザプロファイルは、ライブ ChatGPT Web 検証の場合にのみ必要です。ACP エージェントは、Agent Bridge が起動する前に、それぞれのサポートされたクライアントログインフローを通じて認証されていることが期待されます。

## Bridge CLI

ソース開発中は、以下の `agent-chatgpt` を `bun src/cli/index.ts` に置き換えられます。

Bridge デーモンを開始:

```bash
agent-chatgpt serve
```

既定のエンドポイント:

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

別ツールの出力をセッションにパイプ:

```bash
git diff | agent-chatgpt ask --session code-review --stdin
```

## MCP

Agent -> ChatGPT MCP サーバーを起動:

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

## 外部エージェントと有界協調

元の汎用アダプターは厳密な subprocess JSONL 規約を使用します:

```bash
agent-chatgpt run \
  --objective "Find and fix the parser race" \
  --agent-command ./my-agent-wrapper \
  --max-rounds 20
```

ネイティブ ACP アダプターは、ターミナルスクレイピングではなく公式の ACP プロトコルフレーミングを使用します。組み込み起動プロファイルは以下の通りです:

```text
cursor       -> agent acp
gemini       -> gemini --acp
claude       -> claude-agent-acp
antigravity  -> agy-acp
```

アダプターのセマンティクスについては [`docs/agent-adapters.md`](docs/agent-adapters.md) を、実クライアント P3 リリースゲートについては [`docs/ACP_LIVE_SMOKE.md`](docs/ACP_LIVE_SMOKE.md) を参照してください。

## ライブ ACP 検証

各クライアント独自のログイン機構で認証を行った後:

```bash
bun run smoke:acp:live -- --profile cursor
bun run smoke:acp:live -- --profile gemini
bun run smoke:acp:live -- --profile claude
bun run smoke:acp:live -- --profile antigravity
```

各実行は、隔離された一時ワークスペースで初期化、同一セッション 2 ラウンド継続性、fail-closed な変更処理、実行中キャンセル、キャンセル後リカバリ、および所有プロセスのクリーンアップを検証します。

## プロバイダールーティング

ChatGPT Web は引き続き直接プロバイダーです。`codex-router` はオプションとして下流プロバイダープレーンとして構成可能です。公開モデル ID はグローバルに一意のままです。例:

```text
chatgpt-web/high
codex-router/anthropic-api/...
codex-router/deepseek/...
```

フォールバックは既定で無効です。有効化された場合、候補とトリガー健全性状態は明示的でなければならず、ルーティング決定は実行前に永続化され、フォールバックターンが永続セッションのプロバイダー/モデル識別情報をサイレントに変更することはありません。

[`docs/CODEX_ROUTER.md`](docs/CODEX_ROUTER.md) を参照してください。

## 検証およびリリース状態

決定論的チェック:

```bash
bun run typecheck
bun test
bun run verify
bun run app:package
bun run app:smoke
```

CI は macOS、Linux、Windows でサポートされる verification/package/smoke マトリクスを実行します。

現在のマイルストーン状態:

```text
P1 core + codex-router provider plane        DONE + LIVE SIGN-OFF
P2 provider health / explicit routing       DONE + CI VALIDATED
P3 native ACP external-agent adapter        DONE + LIVE SIGN-OFF
P4 role-based collaboration                 DONE + LIVE SIGN-OFF
P5 bounded multi-participant DAG            IN PROGRESS
```

証拠と実装順序については [`IMPLEMENTATION_PROGRESS.md`](IMPLEMENTATION_PROGRESS.md) を、現在の P5 契約については [`docs/P5_BOUNDED_COLLABORATION_DAG.md`](docs/P5_BOUNDED_COLLABORATION_DAG.md) を参照してください。

## アーキテクチャおよび実装のリファレンス

- [`implementation.md`](implementation.md) — 既存の Bridge 不変条件に関する正式な実装仕様
- [`GOALS.md`](GOALS.md) — プロバイダー非依存のプロダクト方向性とマイルストーン定義
- [`docs/architecture.md`](docs/architecture.md) — アーキテクチャ背景
- [`docs/API.md`](docs/API.md) — ネイティブ REST 契約
- [`docs/MCP.md`](docs/MCP.md) — Agent -> ChatGPT MCP サーフェス
- [`docs/agent-adapters.md`](docs/agent-adapters.md) — 外部エージェントプロトコルとアダプターモデル
- [`docs/ACP_LIVE_SMOKE.md`](docs/ACP_LIVE_SMOKE.md) — P3 実クライアント相互運用性ゲート
- [`docs/security-model.md`](docs/security-model.md) — 信頼境界とセキュリティ
- [`docs/development.md`](docs/development.md) — コントリビューターワークフロー
- [`docs/upstream-patches.md`](docs/upstream-patches.md) — 上流同期メモ
- [`IMPLEMENTATION_PROGRESS.md`](IMPLEMENTATION_PROGRESS.md) — 証拠に基づく現在のステータス

## License

MIT。継承された上流コードには元のライセンス表記が引き続き適用されます。
