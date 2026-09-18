# Agent ChatGPT Bridge

一个本地、与模型提供商无关的协作运行时，让各类 AI Agent 能够与 ChatGPT Web、路由模型提供商以及其他具备 ACP 能力的 Agent 协同工作，无需人工复制粘贴消息。

Agent Bridge 负责协作语义：持久会话、规范 transcript、取消、有边界的工作流、权限、路由策略、持久化与可审计性。提供商特定的认证仍由对应提供商或本地 Agent 客户端管理。

> **状态（2026-09-17）：** P1 已完成真实环境验收，P2 已实现并通过确定性验证，P3 原生 ACP 适配器已实现且跨平台 CI 均为绿色。P3 仍需在真实环境下完成对 Cursor、Gemini CLI 和 Claude ACP 的互操作性验收，方可宣布发布就绪。

## 架构

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

ChatGPT Web 是第一个直接提供商，但不是架构本身。`codex-router` 是下游 `ConversationProvider`；Agent Bridge 始终是更高层的协作平面。

## 与 ARC 和 CompanyOS 的关系

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

- **ARC / adaptive-agent-runtime** 是执行平面：任务 DAG、隔离、实验、恢复、账本、运行时控制。
- **Agent Bridge** 是智能/协作网关：对话、会话、提供商路由、Agent 间交互、权限以及有界协作。
- **CompanyOS** 是之上的协调与产品层。

## 已实现接口

- 带有规范 SQLite transcript 的持久化 Bridge 会话。
- 会话隔离、序列化、取消、中断轮次恢复与重启连续性。
- `agent-chatgpt` CLI：用于会话、消息、模型、MCP 以及有界自动协作运行。
- `/bridge/v1` 本地 REST API，支持 SSE 流式传输与 Bearer Token 保护。
- 用于 Agent -> ChatGPT 交互的 MCP 工具。
- 面向通用外部 Agent 的严格 subprocess JSONL 适配器。
- 原生 ACP 外部 Agent 适配器，支持持久会话、流式传输、取消、权限处理、子进程归属/清理及审计事件。
- Cursor、Gemini CLI、Claude ACP 的内置 ACP 配置文件，以及自定义命令。
- 提供商健康状态观测：`healthy`、`unavailable`、`rate_limited`、`cooldown`、`misconfigured`。
- 仅支持显式配置的有序回退策略；无静默提供商迁移或轮次中途回退。
- 可选的 `codex-router` 提供商平面，支持命名空间模型发现与规范 Agent Bridge 历史。
- 带有轮数、运行时间、连续失败和取消限制的有界自动协作。
- 保留现有上游 `codex-chatgpt-web` CLI 和 `/v1/responses` 兼容性。

## 安全边界

- 模型和 Agent 的输出均被视为不可信内容；不会直接从 Agent Bridge 获得 shell/文件权限。
- ChatGPT Web 登录仍由启动器控制的浏览器手动完成。
- 订阅 Agent / 提供商的身份认证仍由 Cursor、Gemini、Claude、codex-router 或相关提供商持有。Agent Bridge 不会将它们的 OAuth/API 凭据复制到 Bridge 状态中。
- Bridge 与提供商控制面默认只绑定 loopback。
- 原生 Bridge 路由使用由私有运行时控制密钥派生的本地 Bearer Token。
- ACP 文件系统与终端回调默认禁用；除非显式配置，否则权限策略 fail closed。
- 自动循环有明确边界并可取消。
- 不进行静默模型/提供商回退，也不规避使用额度限制。
- 协议歧义、UI 漂移以及缺失终端证据均 fail closed。

启用具备工具能力的工作流前，请阅读 [`docs/security-model.md`](docs/security-model.md)。

## 开发环境

源码运行时要求 Bun 1.4.0。

```bash
git clone https://github.com/anatwork14/agent-chatgpt-bridge.git
cd agent-chatgpt-bridge
bun install --frozen-lockfile
bun run typecheck
bun test
bun run verify
```

仅在进行真实 ChatGPT Web 验证时才需要已登录的 ChatGPT 浏览器配置。ACP Agent 应在 Agent Bridge 启动它们之前，通过各自支持的客户端登录流程完成认证。

## Bridge CLI

源码开发期间，可将下方 `agent-chatgpt` 替换为 `bun src/cli/index.ts`。

启动 Bridge daemon：

```bash
agent-chatgpt serve
```

默认 endpoint：

```text
http://127.0.0.1:8765/bridge/v1
```

创建并继续一个持久会话：

```bash
agent-chatgpt session create --name demo
agent-chatgpt ask --session demo "Remember the number 8427."
agent-chatgpt ask --session demo "What number did I ask you to remember?"
```

检查状态：

```bash
agent-chatgpt status --json
agent-chatgpt models --json
agent-chatgpt session list --json
agent-chatgpt session transcript demo --json
```

从其他工具通过管道输入内容到会话：

```bash
git diff | agent-chatgpt ask --session code-review --stdin
```

## MCP

运行 Agent -> ChatGPT MCP server：

```bash
agent-chatgpt mcp
```

可用工具包括：

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

参见 [`docs/MCP.md`](docs/MCP.md)。

## 外部 Agent 与有界协作

原始通用适配器采用严格的 subprocess JSONL 契约：

```bash
agent-chatgpt run \
  --objective "Find and fix the parser race" \
  --agent-command ./my-agent-wrapper \
  --max-rounds 20
```

原生 ACP 适配器使用官方 ACP 协议帧，而非终端抓取。内置启动 profile 为：

```text
cursor       -> agent acp
gemini       -> gemini --acp
claude       -> claude-agent-acp
antigravity  -> agy-acp
```

关于适配器语义请参见 [`docs/agent-adapters.md`](docs/agent-adapters.md)，关于真实客户端 P3 发布门禁请参见 [`docs/ACP_LIVE_SMOKE.md`](docs/ACP_LIVE_SMOKE.md)。

## 真实 ACP 验证

在通过客户端自身登录机制完成各个客户端认证后：

```bash
bun run smoke:acp:live -- --profile cursor
bun run smoke:acp:live -- --profile gemini
bun run smoke:acp:live -- --profile claude
bun run smoke:acp:live -- --profile antigravity
```

每次运行均在隔离的临时工作区中验证初始化、同会话两轮连续性、fail-closed 变更处理、执行中取消、取消后恢复以及所拥有的进程清理。

## 提供商路由

ChatGPT Web 仍为直接提供商。可选将 `codex-router` 配置为下游提供商平面。公共模型 ID 保持全局无歧义，例如：

```text
chatgpt-web/high
codex-router/anthropic-api/...
codex-router/deepseek/...
```

回退默认禁用。启用时，候选列表与触发健康状态必须明确，路由决策在执行前即被持久化，且回退轮次绝不静默改变持久会话的提供商/模型身份。

参见 [`docs/CODEX_ROUTER.md`](docs/CODEX_ROUTER.md)。

## 验证与发布状态

确定性检查：

```bash
bun run typecheck
bun test
bun run verify
bun run app:package
bun run app:smoke
```

CI 在 macOS、Linux 和 Windows 上执行受支持的 verification/package/smoke 矩阵。

当前里程碑状态：

```text
P1 core + codex-router provider plane        DONE + LIVE SIGN-OFF
P2 provider health / explicit routing       DONE + CI VALIDATED
P3 native ACP external-agent adapter        DONE + LIVE SIGN-OFF
P4 role-based collaboration                 DONE + LIVE SIGN-OFF
P5 bounded multi-participant DAG            IN PROGRESS
```

证据与实施顺序参见 [`IMPLEMENTATION_PROGRESS.md`](IMPLEMENTATION_PROGRESS.md)，当前 P5 契约参见 [`docs/P5_BOUNDED_COLLABORATION_DAG.md`](docs/P5_BOUNDED_COLLABORATION_DAG.md)。

## 架构与实现参考

- [`implementation.md`](implementation.md) — 现有 Bridge 不变量的权威实现规范
- [`GOALS.md`](GOALS.md) — 跨提供商产品方向与里程碑定义
- [`docs/architecture.md`](docs/architecture.md) — 架构背景
- [`docs/API.md`](docs/API.md) — 原生 REST 契约
- [`docs/MCP.md`](docs/MCP.md) — Agent -> ChatGPT MCP 接口
- [`docs/agent-adapters.md`](docs/agent-adapters.md) — 外部 Agent 协议与适配器模型
- [`docs/ACP_LIVE_SMOKE.md`](docs/ACP_LIVE_SMOKE.md) — P3 真实客户端互操作性门禁
- [`docs/security-model.md`](docs/security-model.md) — 信任边界与安全
- [`docs/development.md`](docs/development.md) — 贡献者工作流
- [`docs/upstream-patches.md`](docs/upstream-patches.md) — 上游同步说明
- [`IMPLEMENTATION_PROGRESS.md`](IMPLEMENTATION_PROGRESS.md) — 基于证据的当前状态

## License

MIT。继承的上游代码仍遵循其原始许可证声明。
