# Agent ChatGPT Bridge

一个本地桥接层，让外部 AI Agent 保持主 Agent 身份，同时通过已登录的 ChatGPT Web 会话进行程序化协作。

本项目基于 [`miuuyy/codex-chatgpt-web`](https://github.com/miuuyy/codex-chatgpt-web) 构建。在保留上游 Codex 集成的同时，增加协议无关的会话、REST、MCP、独立 CLI、持久化，以及有边界的 Agent ↔ ChatGPT 自动协作循环。

> **状态：** 1.0 前验证阶段。核心行为已由仓库测试套件和跨平台 CI 覆盖。在正式发布前，仍必须使用真实且已登录的 ChatGPT 会话验证与账户相关的浏览器行为。

## 项目能力

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

外部 Agent 仍负责推理、编码、实验以及判断工作何时完成。ChatGPT Web 是协作对等方、评审者、研究助手、批评者或子 Agent，而不是悄悄替换外部 Agent 的模型后端。

## 已实现接口

- 持久化 Bridge 会话，并隔离 ChatGPT 对话身份。
- `agent-chatgpt` CLI：会话、消息、模型、MCP 和自动协作运行。
- `/bridge/v1` 本地 REST API，支持 SSE 流式传输与 Bearer Token 保护。
- 用于 Agent → ChatGPT 交互的 MCP 工具。
- 面向通用外部 Agent 的严格 subprocess JSONL 适配器。
- SQLite 持久化：sessions、messages、turns、runs、idempotency 和 audit records。
- 带轮数、运行时间、连续失败和取消限制的有界自动协作。
- 通过上游路由实现进行账户感知的 ChatGPT Web 模型发现。
- 在 UI 漂移、缺少终态证据、无效协议帧和模型不可用时 fail closed。
- 保留现有 `codex-chatgpt-web` CLI 和 `/v1/responses` 兼容路径。

## 安全边界

- ChatGPT 输出被视为不可信文本，不会直接执行 shell 命令或修改文件。
- 登录仍由启动器控制的浏览器手动完成。Bridge 不自动输入密码、不绕过 CAPTCHA，也不导入 Cookie。
- Bridge 默认只监听 loopback。
- 原生 Bridge 路由使用由现有私有运行时控制密钥派生的本地 Bearer Token。
- 自动循环有明确边界并可取消。
- 不进行静默模型回退，也不规避使用额度限制。

启用可调用工具或完整 harness 的工作流前，请阅读 [`docs/security-model.md`](docs/security-model.md)。

## 开发环境

源码运行时要求 Bun 1.4.0。

要求：

- Bun 1.4.0
- 上游项目已有的 ChatGPT Web launcher/browser 配置
- 用于真实浏览器验证的已登录 ChatGPT 会话

```bash
git clone https://github.com/anatwork14/agent-chatgpt-bridge.git
cd agent-chatgpt-bridge
bun install --frozen-lockfile
bun run typecheck
bun test
```

浏览器认证仍由上游 launcher 持有。从源码运行时，应先使用现有 launcher/setup 流程登录并验证浏览器界面，再尝试真实 Bridge turn。

## Bridge CLI

源码开发期间，可将下方 `agent-chatgpt` 替换为 `bun src/cli/index.ts`。

启动通用 Bridge daemon：

```bash
agent-chatgpt serve
```

默认 Bridge endpoint：

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

从其他命令通过管道输入内容：

```bash
git diff | agent-chatgpt ask --session code-review --stdin
```

## MCP

运行 Agent → ChatGPT MCP server：

```bash
agent-chatgpt mcp
```

可用工具：

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

## 自动协作 Relay

通用外部 Agent 可以通过严格的 subprocess JSONL 协议参与：

```bash
agent-chatgpt run \
  --objective "Find and fix the parser race" \
  --agent-command ./my-agent-wrapper \
  --max-rounds 20
```

每次调用外部 Agent 时，stdin 接收一行带版本的 JSON；stdout 必须只返回一个合法 decision frame。人类可读日志应写入 stderr。

参见 [`docs/agent-adapters.md`](docs/agent-adapters.md)。

## REST API

原生 API 位于 `/bridge/v1`，包含会话、transcript、模型、取消和协作 run。流式 turn 使用 SSE。

参见 [`docs/API.md`](docs/API.md)。

## Codex 兼容性

本仓库有意保留上游产品路径：

```text
Codex → /v1/responses → codex-chatgpt-web → ChatGPT Web
```

原始 `codex-chatgpt-web` CLI、browser worker、launcher、模型路由、compaction 机制和 Codex harness 都继续作为兼容基础设施。通用 Bridge 包装该运行时，而不是重写它。

## 验证

```bash
bun run typecheck
bun test
bun run verify
bun run app:package
bun run app:smoke
```

CI 在 macOS、Linux 和 Windows 上执行验证。真实浏览器验证被刻意分离，因为它需要真实且已登录的 ChatGPT 账户。

必须完成的真实环境里程碑：

```bash
agent-chatgpt session create --name demo
agent-chatgpt ask --session demo "Remember 8427."
agent-chatgpt ask --session demo "What value did I ask you to remember?"
```

最终回复必须在无需人工复制消息的情况下包含 `8427`。随后还需验证两个会话的隔离、取消、MCP ask/continue，以及至少两轮的自动协作 relay。

参见 [`docs/release-validation-agent-bridge.md`](docs/release-validation-agent-bridge.md)。

## 架构与实现

- [`implementation.md`](implementation.md) — 权威实现规范
- [`docs/architecture.md`](docs/architecture.md) — 架构背景
- [`docs/API.md`](docs/API.md) — 原生 REST 契约
- [`docs/MCP.md`](docs/MCP.md) — Agent → ChatGPT MCP 接口
- [`docs/agent-adapters.md`](docs/agent-adapters.md) — 外部 Agent 协议
- [`docs/security-model.md`](docs/security-model.md) — 信任边界与安全
- [`docs/development.md`](docs/development.md) — 贡献者工作流
- [`docs/upstream-patches.md`](docs/upstream-patches.md) — 上游同步说明
- [`IMPLEMENTATION_PROGRESS.md`](IMPLEMENTATION_PROGRESS.md) — 基于证据的当前状态

## License

MIT。继承的上游代码仍遵循其原始许可证声明。
