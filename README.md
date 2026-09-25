# AgentMesh — 跨机器 AI 智能体统一控制台

> **一句话介绍：**  
> 在一台电脑上，统一管理、调度和监控分布在多台机器上的各种 AI 智能体（Agent）。  
> **零依赖**（仅用 Node.js 内置模块）、**远端免开入站端口**（走安全 SSH 隧道）、**原生适配主流协议**（ACP、A2A、HTTP API 及通用 CLI）。

📖 **要上手操作，看 [`USAGE.md`](USAGE.md)** —— 完整使用手册（每条命令、每种接法、故障排查）。  
设计初衷与实现规划见 [`PLAN.md`](PLAN.md)；测试覆盖与验证记录见 [`ACCEPTANCE.md`](ACCEPTANCE.md)。

---

## 解决什么痛点？

如果你在不同机器（本地电脑、NAS、内网开发机、云服务器等）上跑着多个 AI Agent：
- 本机或服务器里的 **Hermes Agent**
- 运行在远程机上的 **opencode**
- 各大厂商推出的 ACP 智能体（如 **Gemini CLI**、**Claude Code ACP**、**Goose**）
- 各种自定义的命令行 Agent 脚本

你通常会面临这些麻烦：
1. **到处切终端登录**：需要开一大堆终端窗口，频繁 SSH 到各台服务器手动输入指令。
2. **难以统一监控**：无法集中查看多台机器上每个任务的运行状态、实时输出日志和工具调用。
3. **远程交互/审批繁琐**：智能体在远端想执行敏感操作（改文件、运行命令）需要人确认授权时，普通终端直接卡在 stdin 上；一旦网络抖动或终端关闭，任务就直接中断。
4. **网络配置麻烦**：很多工具要求在远程服务器上开入站端口并暴露公网，存在安全风险，内网穿透也格外折腾。

**AgentMesh 把这些全都收束到你眼前的一台电脑上。**

---

## AgentMesh 能做什么？

```
               控制端电脑（你的本地 PC）                            被控节点（服务器 / NAS / 本机）
┌────────────────────────────────────────────────────────┐
│  mesh CLI   /   mesh Web 控制台 (http://127.0.0.1:7331)  │
│  ────────────────────────────────────────────────────  │
│  • 本地智能编排 Agent（自然语言分解并分发任务）           │
│  • 任务存储与统一状态机（基于 SQLite，支持断点续接）       │
│  • 异步审批中心（Web 界面一键授权 / 终端异步作答）         │
│  • 统一多协议适配器（Adapters）                          │
│     ├─ ACP 适配器      (stdio JSON-RPC)  ──[SSH 隧道]──▶  hermes-acp / opencode acp / gemini
│     ├─ A2A 适配器      (HTTP+SSE)        ──[HTTP/内网]─▶  Hermes A2A / 标准 A2A 节点
│     ├─ opencode 适配器 (HTTP /event)     ──[HTTP/内网]─▶  opencode serve
│     └─ CLI 适配器      (一次性子进程)    ──[SSH/本地]──▶  任意常规命令行 Agent
└────────────────────────────────────────────────────────┘
```

1. **统一任务派发与会话管理**：
   - **你指哪它打哪**（`mesh send`）：明确指定服务器与 Agent，适合脚本和日常操作。
   - **自然语言编排**（`mesh agent`）：只需说出意图，本机编排 Agent 自动判断该派给哪台机器的哪个 Agent，并把结果原样汇总带回。
   - **断点续接**：连接即使意外断开，会话仍然保存在本地 SQLite 中，随时可通过 `--continue` 恢复上下文。
2. **远端免开端口（SSH 隧道）**：
   - ACP 协议（稳定版规范）基于 stdio 管道运行。
   - AgentMesh 利用本地系统原生 SSH 管道直接连接远端 Agent，**被控服务器无需开放任何额外 HTTP 端口，只要能 SSH 登录就能管**。
3. **可挂起的远程异步审批（Human-in-the-loop）**：
   - 远端智能体请求高危权限时，任务自动挂起并落库为审批项，任务转入 `input-required` 状态。
   - 你可以在 Web 控制台点击按钮一键放行，或在任意终端执行 `mesh approve` 作答，不再因终端卡死或关闭而丢任务。
4. **轻量与安全优先**：
   - **零第三方依赖**：纯 Node.js 实现（利用内置 SQLite、fetch 和原生模块），无需 `npm install`。
   - **凭据最小化**：控制端仅维护访问节点所必需的 SSH 密钥或端点 Token；目标机器上运行 Agent 所需的大模型 API Key 完全留在节点侧，控制面不集中托管。
   - **默认安全与本地保护**：Web 控制台默认绑定 `127.0.0.1`（离开本地环回强制要求配置认证账号）；权限审批默认全部拒绝。

---

## 为什么这样设计？（设计原则）

1. **会话与连接解耦**：连接断开，会话还在 Store 里，可 `--continue` 恢复（A2A 用 `contextId`，ACP 用 `sessionId`），不把任何状态托付给易波动的网络传输层。
2. **审批是可寻址、可恢复的资源**：智能体请求授权时不阻塞等 stdin，而是落库成一条 approval 记录；在 CLI 上 `mesh approve` 或 Web 控制台点一下就能恢复。
3. **凭据只留在节点侧**：控制面只持有"访问节点所需"的令牌（A2A bearer、SSH key），不持有各智能体的模型 API Key。
4. **默认安全**：ACP 客户端默认**不**宣告 `fs`/`terminal`（智能体使用服务器自有的工具执行）；审批策略默认 `deny`；A2A 无 token 不启用；注册表里的密钥不会下发给前端。

### 为什么 ACP 走 SSH 而不是 HTTP
ACP 稳定版的传输协议是 stdio（JSON-RPC + 换行分隔 JSON）——"Streamable HTTP" 目前仍是草案。这反而是巨大的工程优势：`ssh host hermes-acp` 就是天然的双向安全 stdio 管道，实现**远端零安装额外网关、零入站端口**，只要能 SSH 就能管。

---

## 环境要求

- **Node.js ≥ 22.5.0**（用到内置 `node:sqlite`、全局 `fetch` 等）。已在 Node 24 上验证。
- **零依赖**：无 npm 第三方依赖，无需运行 `npm install`。

## 快速开始

```bash
# 1) 启动 Web 控制台（浏览器打开 http://127.0.0.1:7331）
node bin/mesh.js serve --port 7331

# 2) 注册节点（例如通过 SSH 免开端口接入远程服务器上的 Hermes）
node bin/mesh.js node add server-hermes --kind hermes --ssh 192.168.1.100 --ssh-user root --cwd /srv/work

# 3) 探测节点能力（握手、获取 Agent 卡片与鉴权状态）
node bin/mesh.js probe server-hermes

# 4) 向远程节点发一个任务
node bin/mesh.js send server-hermes "列出当前目录并总结这个项目是做什么的"
```

> 提示：如果将 `bin/mesh.js` 加入 PATH（或执行 `npm link`），可直接用 `mesh` 代替 `node bin/mesh.js`。

---

## 两种使用模式：你指定目标，还是只说意图

```bash
# 模式 A：你指定目标（明确、可预期、适合脚本自动化）
mesh send nas-hermes "写一个判断素数的 Python 函数"

# 模式 B：你只说意图（本机编排 Agent 查节点列表、自行决策并派发，再把结果带回来）
mesh agent "让 nas 上的 agent 写一个判断素数的函数，并把完整代码返回给我"
```

`mesh agent` 是一个在本机运行的编排 Agent 循环：它可以看到你的节点清单与各节点能力，先探测判断、再精准派发，最后原样带回远程答复。它具备完善的权限控制（`--dry-run`、`--read-only`、`--tools`、`--max-steps`）。详见 [USAGE.md §4.7](USAGE.md)。

---

## 命令速查

| 命令 | 说明 |
|---|---|
| `mesh node add/list/show/remove/check` | 管理节点 |
| `mesh node edit <node> [--unset <field>]` | **改节点字段**（只改你传的；`--unset` 可重复，用于删字段） |
| `mesh probe <node>` | 能力探测（A2A 抓 Agent Card；ACP 做 initialize） |
| `mesh agent "<一句话>"` | **本地编排 Agent**：它自己判断该派给哪台机器的哪个 Agent |
| `mesh agent` | 交互式会话（多轮） |
| `mesh agent save/config/models` | 配置/查看它用的大模型 |
| `mesh send <node> "<prompt>" [--continue] [--approval ask]` | 发任务 |
| `mesh send <node> "<prompt>" --share-context` | 发任务时**带上其他节点最近的往来**（多 Agent 协作；默认隔离） |
| `mesh secrets set/list/rm/path` | **让密码跨重启保留**（存进 `~/.agentmesh/secrets.env`，0600，明文；见下） |
| `mesh broadcast "<prompt>" [--node a --node b \| --capability web] [--mode all\|first\|best]` | 扇出 |
| `mesh tasks` / `mesh task <id> [--events]` | 任务历史 |
| `mesh watch [--task <id>]` | 实时事件流 |
| `mesh approvals` / `mesh approve <id> --allow` | 审批队列 / 远程作答 |
| `mesh cancel <taskId>` | 取消 |
| `mesh status` | 总览 |
| `mesh serve [--port 7331]` | Web 控制台 + 本地 API |
| `mesh presets` | 内置 agent 预设 |

`--json` 让任何命令输出机器可读的结果（事件走 NDJSON）；`send` 与 `agent` 默认把**回答写到
stdout**、把进度与工具调用写到 stderr，所以 `mesh send n "..." > answer.txt` 拿到的就是干净回答。

### 两种用法：你指定目标，还是你只说意图

```bash
# 你指定目标：明确、可预期、适合脚本
mesh send nas-hermes "写一个判断素数的 Python 函数"

# 你只说意图：本机这个 Agent 自己决定派给谁，再把结果带回来
mesh agent "让 nas 上的 agent 写一个判断素数的函数，并把完整代码返回给我"
```

`mesh agent` 是一个**在本机跑的 Agent 循环**（不是又一个框架）：它看得见你的节点清单，会先查、
再判断、再派发，然后**原样**把远端 agent 的答复带回来。它只有六个工具
（`list_nodes` / `probe_node` / `list_tasks` / `get_task` / `send_task` / `broadcast`），权限
用开关控制（`--dry-run` / `--read-only` / `--tools` / `--confirm` / `--max-steps`）。
远端 agent 能做什么，仍然由**远端自己的策略**决定——它是派发者，不是权限的绕过者。
详见 [USAGE.md §5.7](USAGE.md)。

---

## 接入各种节点

### Hermes（两种接法）

**A. ACP over SSH —— 免开端口（推荐给跨机）**

```bash
mesh node add hermes-b --kind hermes --ssh 10.0.0.5 --ssh-user root --cwd /srv/work

# 非 OpenSSH 的客户端（Windows 上的 plink、或包了一层的跳板脚本）：
# 注意：值本身以 "-" 开头时必须用 = 形式，否则它不会被当作值（会直接报错提示你）。
mesh node add hermes-b --kind hermes --ssh 10.0.0.5 \
  --ssh-binary 'C:\tools\plink.exe' --ssh-binary-arg=-batch

# 节点级环境变量会随远端命令一起送达（`cd <cwd> && exec env K=V <cmd>`）：
mesh node add hermes-b --kind hermes --ssh 10.0.0.5 --env HERMES_MODEL=deepseek/deepseek-v4.1-flash

# 需要跳板机 / 自定义 known_hosts 时，原样透传任意 ssh -o 选项：
mesh node add hermes-b --kind hermes --ssh 10.0.0.5 \
  --ssh-opt ProxyJump=bastion --ssh-opt UserKnownHostsFile=/etc/agentmesh/known_hosts
```

**只接受密码的主机。** AgentMesh 默认 `BatchMode=yes`，因为 ACP 的稳定传输就是 stdio，
而 ssh 的密码提示会去读 stdin —— 那正好是协议管道。密码型主机要走 `SSH_ASKPASS`：
让一个助手程序回答提示，stdin 就干净了。Windows 上唯一通用的助手解释器是 `node.exe`，
而它需要 `NODE_OPTIONS=--require` 才能充当助手 —— **这个变量会被继承**，直接 export 的话
`mesh` 自己会把密码打到 stdout 上，所以仓库里给了一层只作用于 ssh 子进程的包装器：

```powershell
# 密码只存在于环境变量里，不写进 nodes.json，也不落盘
$env:MESH_ASKPASS_SECRET = '<password>'

mesh node add nas --kind hermes --ssh 10.0.0.5 --ssh-user me --ssh-port 2222 `
  --ssh-batch-mode no `
  --ssh-binary "<node.exe 的路径>" `
  --ssh-binary-arg "<仓库>\tools\ssh-askpass.mjs" `
  --ssh-binary-arg "C:\Windows\System32\OpenSSH\ssh.exe" `
  --ssh-opt "UserKnownHostsFile=<仓库>\.ssh\known_hosts" `
  --ssh-opt "StrictHostKeyChecking=accept-new" `
  --command /opt/hermes/bin/hermes-acp `
  --cwd /srv/work --env HERMES_HOME=/tmp/mesh-hermes
```

这是**接线用的权宜方案**；能装公钥就装公钥（`--ssh-key`），那样可以回到默认的 `BatchMode=yes`。
真实的 NAS 实测记录见 `ACCEPTANCE.md` 第 5.6 节。

**B. 原生 A2A —— 零改造，只要在 B 上开端口**

```bash
# 在 B 服务器上：
A2A_PORT=9900 A2A_AGENT_NAME=hermes-b A2A_BEARER_TOKEN=<secret> hermes gateway run

# 在 C 上：
mesh node add hermes-a2a --transport a2a --url http://10.0.0.5:9900 --token <secret>
mesh probe hermes-a2a        # 会打印 Agent Card 的名称、能力、skills
```

### opencode

```bash
# 在 A 服务器上：
OPENCODE_SERVER_PASSWORD=<pass> opencode serve --port 4096 --hostname 0.0.0.0

# 在 C 上：
mesh node add oc-a --transport opencode --url http://10.0.0.6:4096 --password <pass>
mesh probe oc-a              # 用 /doc(OpenAPI) 自检端点是否存在，不靠硬编码猜测
```

### 任何 ACP agent

`gemini`、`claude-agent-acp`、`codex-acp`、goose… 只要是 ACP over stdio：

```bash
gemini --experimental-acp                     # 官方 ACP 模式
mesh node add g --transport acp --local --command gemini --arg --experimental-acp
```

### 兜底：只会 CLI 的 agent

```bash
mesh node add legacy --transport cli --ssh 10.0.0.7 \
  --command "my-agent" --arg "--yes" --arg "{prompt}"
```

`{prompt}` 会被替换；不写占位符则把 prompt 追加为最后一个参数。
也可以通过 stdin 投喂：在节点配置里加 `"promptVia": "stdin"`（**这是配置字段，没有对应的 CLI flag**，
手改 `nodes.json` 或用 `POST /api/nodes` 注册）。

---

## 远程审批（这是重点）

agent 请求授权时，AgentMesh 有两种处理方式，由 `--approval` 决定：

| 策略 | 行为 |
|---|---|
| `deny`（默认） | 自动拒绝，agent 会绕开受限操作 |
| `allow-once` | 自动允许这一次 |
| `allow-always` | 优先选 `allow_always` |
| `ask` | **挂起**请求，任务转 `input-required`，等你在 C 上作答 |

`ask` 是唯一"需要人"的策略。挂起的请求会：

1. 落库成一条 approval 记录（可 `mesh approvals` 查到）；
2. 出现在 Web 控制台的"待审批"面板；
3. 通过 `POST /api/approvals/:id` 作答后，JSON-RPC 响应才真正写回 agent；
4. 超时（默认 15 分钟）自动按"取消"回执，避免 agent 永远卡住。

```bash
mesh serve &                                   # 由它持有活动连接
mesh approvals                                 # 看到 APP id
mesh approve appr_xxxx --allow                 # 恢复
```

> 注意：审批由**持有活动连接的那个进程**负责写回。所以要用 `mesh serve`（或 `mesh watch`）常驻；
> 如果直接前台 `mesh send --approval ask` 且当前是 TTY，CLI 会就地弹交互式选择。

### 远端要权限：只有 ACP / opencode 能真正"问你"，A2A 只能"停下等你说话"

上面那张表说的是**选项式**审批——远端给出选项列表，你选一个。这是 ACP（`session/request_permission`）
和 opencode 的模型，所以「待审批」面板能把它渲染成按钮，**这条路已经完整可用**。

**A2A 不是这个形状**：它只有一个 `TASK_STATE_INPUT_REQUIRED` 状态，要的是**一段自由文本**，回答方式是
"在同一个 `contextId` 里再发一条消息"。所以：

- 远端停下来时，你不会只看到一个状态名 —— 命令行会打印对端原话 + 你能照抄的那条回答命令，
  控制台会出现一条最醒目的黄线并告诉你**在这一页怎么回答**（选同一节点 → 勾「续接上次会话」→ 发送）；
- `--approval` 打在 A2A 节点上会**明确告诉你它没有作用**（而不是默默忽略），并指出去路；
- 如果对端**根本不说** `input-required`（例如只是个包了 CLI 的 HTTP 壳，审批提示发生在它内部子进程的
  stdin 上），**本机无从得知**，也没有协议层的办法能修 —— 要改的是对端。最省事的路通常是
  **改用 ACP 连它**（Hermes 有原生 ACP，本项目有验证过的 ACP over SSH 通路，不需要在对端开端口），
  审批链路立刻就是现成的、带 UI 的。

详见 [USAGE.md §6.5](USAGE.md)。

---

## Web 控制台

> ⚠️ **控制台没有任何认证。** 默认绑定 `127.0.0.1`（只有本机能连），**请保持这个默认值**。
> 绑到非回环地址（如 `--host 0.0.0.0`）等于把一个无认证的远程命令执行入口公开出去——
> 任何能连上端口的人都能增删节点、派发任务（在远端主机上执行命令）并批准审批。
> 需要远程访问请用 SSH 端口转发。详见 [`SECURITY.md`](SECURITY.md)。

`mesh serve` 之后浏览器打开 `http://127.0.0.1:7331`，可以：

- 看节点列表、一键**探测**能力
- 表单**注册**新节点（预设 + 目标 + token）
- 发任务、选审批策略、续接上次会话、**带上其他节点的最近往来**、取消运行中的任务
- **和本机编排 Agent 对话**：每一轮的思考与工具调用**折叠成一行**（点开可看），答复始终显示；
  显示什么由两个开关控制（思考 / 工具调用，默认都关，记在浏览器里）
- **实时事件流**（SSE，断线自动从 `?after=<seq>` 续传；同一段流式输出的连续碎片合并成一行）
- **待审批面板**：直接点按钮作答
- 最近任务表

本地 API（也方便脚本化）：`/api/status`、`/api/nodes`、`/api/tasks`、`/api/events`、`/api/stream`（SSE）、
`/api/send`、`/api/cancel`、`/api/approvals`、`/api/approvals/:id`。

---

## 统一任务状态模型

以 A2A 状态机为基准，把 ACP 的 `stopReason` 映射进来：

| 统一状态 | A2A | ACP |
|---|---|---|
| `queued` | — | — |
| `submitted` | `TASK_STATE_SUBMITTED` | — |
| `working` | `TASK_STATE_WORKING` | `session/prompt` 进行中 |
| `input-required` | `TASK_STATE_INPUT_REQUIRED` | `session/request_permission` 挂起 |
| `auth-required` | `TASK_STATE_AUTH_REQUIRED` | 需要 `authenticate` |
| `completed` | `TASK_STATE_COMPLETED` | `stopReason: end_turn` |
| `failed` | `TASK_STATE_FAILED` | `refusal` / `max_tokens` / 进程异常 |
| `canceled` | `TASK_STATE_CANCELED` | `stopReason: cancelled` |
| `rejected` | `TASK_STATE_REJECTED` | — |

---

## 状态与配置位置

默认 `~/.agentmesh/`，可用 `AGENTMESH_HOME` 覆盖：

- `nodes.json` —— 节点注册表（可直接手改）
- `mesh.db` —— SQLite：`tasks` / `events` / `approvals`
- `llm.json` —— 编排 Agent 的地址与模型（**不含密钥**）
- `secrets.env` —— **可选**，`mesh secrets set` 写入的密码文件（`0600`，**明文**，只在你自己要求时才存在）
- `console-users.json` —— **可选**，`mesh auth` 建的控制台账号（`0600`，存 **scrypt 哈希**，**不可还原**）

密码不写进 `nodes.json`：节点里存的是**变量名**。想让它跨重启可用，要么自己在环境变量里设值，要么用
`mesh secrets set NAME` 把它存进 `secrets.env`——**保护来自文件权限，不是加密**，更优解是改用 SSH 密钥。
完整说明见 [USAGE.md §7.4](USAGE.md)。

注意这两类密码的存法**故意相反**：SSH 密码必须能还原（要交给 `ssh`），所以只能明文；控制台登录口令
只需要**校验**，所以存不可逆哈希。见 [USAGE.md §7.8](USAGE.md)。

---

## 测试

```bash
npm test                            # 240 个用例 / 19 个文件
# 等价于逐个直接执行（受限环境下 node --test 要开子进程，可能被拒）：
node test/protocol.test.js          # ACP 分帧与权限结构、A2A 线格式、SSE、JSON-RPC 双向、状态映射
node test/args.test.js              # argv 解析：可重复 flag 取值与缺值报错、-- 终止、= 形式、布尔不吞提示词
node test/a2a-adapter.test.js       # A2A 适配器：对忠实复刻 Hermes 线格式的 mock 做真实 HTTP/SSE
node test/opencode-adapter.test.js  # opencode：prompt_async + /event 流式、权限挂起与作答
node test/http.test.js              # HTTP 传输层：Bearer/Basic 鉴权头、网络失败归因（拒绝 vs 丢包）、超时
node test/llm.test.js               # OpenAI 兼容客户端：工具调用归一化、网关错误按正文分流、无 key 不发鉴权头
node test/orchestrator.test.js      # 编排循环：工具集裁剪、失败作为数据回喂、dry-run/白名单/步数上限
node test/acp-lifecycle.test.js     # 真实子进程下的连接生命周期：probe 后再 send、断连可重连
node test/cli-cancel.test.js        # mesh cancel 不得谎报：无活动连接时必须拒绝，且不改记录
node test/approval.test.js          # 审批是可寻址资源、跨运行 id 唯一性、过滤语义
node test/fleet.test.js             # 扇出目标选择 + 密钥隔离：密码只进内存不落盘、点号路径 unset
node test/store.test.js             # 任务/事件持久化、?after= 重放、崩溃恢复对账、旧库迁移
node test/ssh.test.js               # SSH 命令构造、注入防护、exec vs sh -c、alternate ssh binary
node test/web.test.js               # 控制面：字段完整落盘、密码不落盘也不回落 token、编辑只改给定字段
node test/net.test.js               # fetch 不可连接的端口：禁止列表与当前 Node 行为一致、重掷不会死循环
```

> `test/acp-lifecycle.test.js` 与 `test/cli-cancel.test.js` 会真的开子进程。在没有管道 stdio
> 权限的环境里（比如受限沙箱）这些用例会**明确跳过并说明原因**，而不是伪装成通过。

真实端到端（本机需已装好 Hermes）：

```bash
node bin/mesh.js probe hermes-local
node bin/mesh.js send hermes-local "用一句话说明你是什么"
node bin/mesh.js serve --port 7359 &
node tools/verify-approval.mjs 7359 hermes-local    # 审批闭环，15 项检查
node tools/verify-ssh-acp.mjs                       # ACP over SSH 路径，13 项检查

# A2A：内置一个真实 A2A v1.0 服务端（真 HTTP / JSON-RPC / SSE），23 项检查
node tools/verify-a2a.mjs
node tools/verify-a2a.mjs --url http://<host>:9900 --token <token>   # 或直接测一个真实端点，10 项检查

# 多轮对话：对端不维护上下文时，由客户端把历史带上（ACP/opencode 不需要这个开关）
node bin/mesh.js send hermes-b-a2a "记住这个数字：7391"
node bin/mesh.js send hermes-b-a2a "我让你记的数字是多少？" --continue --with-history

# 真机验收：对一台真实远端主机（真实 sshd / 登录 / Hermes）跑完整闭环，35 项检查
node tools/verify-lan.mjs --node nas-hermes --dir /srv/work --log logs/lan-acceptance.txt

# 本地编排 Agent：脚本化 LLM + 真实 A2A 对端，28 项检查（无需任何外部服务）
node tools/verify-agent.mjs --log logs/agent-acceptance.txt

# 控制面：用浏览器那套 HTTP 调用打真控制面 + 真 NAS（21 项；需真 ssh，受限沙箱内 2 项会失败）
node tools/verify-console.mjs --host 10.0.0.5 --port 2222 --user user

# 文档自检：各文档声称的用例数/文件数/缺陷数是否互相一致，链接与脚本是否都存在
node tools/check-docs.mjs

# 控制台界面静态自检（先跑检查器自己的自测，再检查 ui.html）—— npm run check:ui
node tools/check-ui.selftest.mjs && node tools/check-ui.mjs
```

`verify-ssh-acp.mjs` 用 `tools/fake-ssh.mjs` 顶替 ssh **传输本身**，但保留 AgentMesh 负责的全部内容：
ssh argv、远端命令行、以及 ACP 赖以运行的 stdio 管道。`verify-a2a.mjs` 则起一个**真正对外说话的
A2A 服务端**（`tools/fake-a2a-server.mjs`：强制鉴权、非根路径 RPC、流式 artifact），用来证明客户端
这一侧；也可以 `--url` 直接指向任何真实端点，此时它会给出"没人监听"与"防火墙丢包"的区分结论。
`verify-lan.mjs` 不顶替任何东西：真实主机、真实认证、真实智能体，并且**自己通过 ssh 把产物读回来核对**
（内容 + `md5` + `mtime`），不听 agent 自述。`verify-agent.mjs` 只顶替两件会让结果不可复现的东西
（LLM 与远端 agent），编排循环、权限闸门、Store 落库全部是产品代码路径。各自验证什么、不验证什么，
见 [`ACCEPTANCE.md`](ACCEPTANCE.md)。

已验证 / 未验证的完整清单见 [`ACCEPTANCE.md`](ACCEPTANCE.md)，含验证过程中抓出的
66 个真实缺陷及各自的触发条件。

---

## 已知限制

> 逐项状态以 [`ACCEPTANCE.md`](ACCEPTANCE.md) 第 5 节为准。核心的 ACP 通道（本机 Hermes）
> 与审批闭环都是**实跑验证过**的；下面这些是**没有真实对端、未做端到端**的部分。

- **SSH 传输**：**已在真实主机上跑通**（`ACCEPTANCE.md` 5.6，35/35）：真实 sshd、真实密码认证、
  真实主机密钥校验、真实远端 Linux（Debian 12）、真实远端 Hermes，两个任务都在远端留下了产物。
  **尚未验证的是**密钥认证（那台 NAS 没有家目录，需 `sudo` 建，属于对用户系统的持久改动）、
  `ProxyJump` 跳板机、以及网络中断/超时的恢复行为。
- **opencode 适配器**：本机未安装 opencode，只对着**逐字节复刻其线格式的 mock** 验证过。
  适配器会先读 `/doc`（OpenAPI）自检端点是否存在，端点名可用节点配置里的 `endpoints` 覆盖，
  便于跟随版本漂移。
- **真实 A2A 对端**：未启动 `hermes gateway`（避免与你正在运行的 Hermes 实例争用状态与端口），
  只对复刻 Hermes `a2a/protocol.py` 形状的 mock 验证。
- **`fs/*` / `terminal/*` 客户端能力**：默认不宣告（设计选择）。`fs/*` 有实现但从未被真实 agent 触发。
- **多节点扇出**：`mesh broadcast` 只有单节点实跑，`--mode first/best` 未经真实多节点验证。
- **ACP v2**：官方明确"不要默认在生产启用"，本项目只实现稳定版 v1（`protocolVersion: 1`）。
- **MCP 未参与主干**：MCP 已改为无状态（2026-07-28 起删除 `initialize` 握手与 SSE 续传），
  不适合做控制面通道；仅适合给 agent 挂工具。
- **Windows 上的 HTTPS**：某些受限环境下 Windows schannel 不可用（`SEC_E_NO_CREDENTIALS`），
  Node 自带 OpenSSL 正常——本项目用 `fetch`，不受影响。`tools/fetch.mjs` 就是为此写的。

## 目录结构

```
bin/mesh.js              CLI 入口
src/protocol/            协议层（纯函数 + 线格式，无 IO）
  acp.js a2a.js jsonrpc.js states.js events.js util.js
src/core/
  registry.js            节点注册表
  store.js               任务/事件/审批（node:sqlite）
  fleet.js               派发、扇出、审批路由
  llm.js                 OpenAI 兼容客户端（零依赖，密钥永不落盘）
  orchestrator.js        本地编排 Agent 的循环 + 工具集 + 权限闸门
  transport/             spawn.js  ssh.js  http.js
  adapters/              acp.js  a2a.js  opencode.js  cli.js
src/web/                 server.js + ui.html（控制台，含 Agent 对话面板）
src/cli/                 main.js args.js render.js
test/                    测试（含 test/helpers/fake-acp.mjs：真子进程用的最小 ACP agent）
tools/                   调研与验证脚本
  verify-lan.mjs         真机验收：真实 sshd + 真实远端 Hermes，并独立回读远端产物
  verify-ssh-acp.mjs     SSH 路径验收（传输层由 fake-ssh.mjs 顶替）
  verify-approval.mjs    审批闭环验收（全程只走 Web API）
  verify-agent.mjs       本地编排 Agent 验收（脚本化 LLM + 真实 A2A 对端）
  fake-a2a-server.mjs    可对外说话的 A2A 服务端（强制鉴权、非根路径 RPC、流式 artifact）
  check-docs.mjs         文档自检：跨文档计数一致、链接可解析、缺陷表连续
  ssh-askpass.mjs        把 SSH_ASKPASS 的作用域收窄到 ssh 子进程（只接受密码的主机用）
  askpass.cjs            被上面的包装器预载、只负责打印密码就退出
logs/                    验证转录（已 gitignore；运行 tools/verify-*.mjs --log 生成）
research/                调研语料（已 gitignore；用 tools/fetch.mjs 重新抓取）
```

## 许可

MIT
