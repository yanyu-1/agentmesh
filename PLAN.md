# AgentMesh 规划书 —— 跨机器统一智能体控制面

> 版本 0.1 · 目标：在 C 电脑上一个控制台统管分布在不同服务器上的异构智能体
> （A 服务器 opencode、B 服务器 Hermes、以及任何支持 ACP/A2A 的 agent）

---

## 1. 问题与目标

现状：智能体（opencode / Hermes / Gemini CLI / Claude Code / Codex …）各自安装在不同机器上，
每个都有自己的 CLI、自己的 HTTP 端口、自己的鉴权方式、自己的会话存储。
人在 C 电脑上要管它们，就得记 N 套用法、开 N 个终端、在 N 套日志里找结果。

目标：**一个控制面**（CLI + Web），做四件事：

1. **看得见**：一屏列出所有节点（在线/离线、版本、能力、当前任务数）。
2. **发得出去**：一条命令把任务发给任意节点或一组节点（按能力扇出）。
3. **看得清**：任务状态、流式输出、工具调用、审批请求实时回到 C。
4. **回得来**：会话可续（context/session 持久化）、任务可取消、审批可远程作答、历史可检索。

### 1.1 范围变更（原始非目标中有一项被推翻）

初稿把「不做自有 agent 推理」列为非目标。**这一条后来被需求推翻了**：用户要求 C 电脑上能直接
对本地一个 Agent 说一句话（例如"让 NAS 的 Agent 写一个函数"），由**它自己判断**该把任务派给哪个
远端节点，并把派发、重试、汇总都做完。这正是"自有 agent 推理"，于是它成了**范围内的核心功能**
（约束在里程碑 M8）。因此：

- 仍然**不做**的：模型路由（把请求按成本/能力自动分发到不同模型）、替代各 agent 自己的工具系统、
  自建推理模型。
- **新增**的：一个**编排 Agent**——复用 OpenAI 兼容的 `tools` 调用，循环 = 模型决定 → 工具执行 →
  结果回灌；它的工具集就是 `Fleet` 本身（`send_task`/`probe_node`/`get_task`…）。

初稿 §3.1 第 3 条「凭据只留在节点侧」也随之需要补充：编排 Agent 必须持有**一个**模型 API key
（否则它无法推理）。处理方式见 §3.1 第 5 条——**任何密钥都不落盘**。

---

## 2. 调研结论（决定架构的关键事实）

完整调研（含逐条出处 URL）为本地语料 `research/landscape.md`，**不随仓库分发**；用 `node tools/fetch.mjs` 可重新抓取。
以下每条都改写了设计：

| # | 事实 | 对设计的强制约束 |
|---|---|---|
| 1 | **ACP（Agent Client Protocol）稳定版 = v1，传输层只有 stdio**（JSON-RPC 2.0 + nd-JSON）。"Streamable HTTP" 仍是草案。 | ACP 必须走 stdio。跨机 = **stdio over SSH**，这正好意味着**远端零部署、零入站端口**。 |
| 2 | ACP v1 有 13 个 agent 方法、11 个 client 方法；`session/request_permission` 由 **agent 反向请求 client**。 | 控制面必须能作为 ACP *client* 处理反向请求（权限、fs、terminal）。审批要能"挂起—远程作答—恢复"。 |
| 3 | ACP 官方注册表 41 个 agent（含 opencode 1.18.31、gemini、goose、Codex、Claude Agent…），且有强制鉴权声明。 | 节点"能力发现"可以直接对齐官方注册表语义，不必自创。 |
| 4 | **A2A 已归 Linux Foundation**，是 **agent↔agent** 协议；`/.well-known/agent-card.json` 发现；三种绑定 JSON-RPC / gRPC / HTTP+JSON；状态机 `SUBMITTED/WORKING/INPUT_REQUIRED/AUTH_REQUIRED/COMPLETED/FAILED/CANCELED/REJECTED`。 | A2A 适合"节点主动暴露自己"的场景（Hermes 原生支持）。控制面把 A2A 状态机作为**统一任务状态模型**。 |
| 5 | **Hermes 自带完整 A2A v1.0 服务端 + 客户端工具**（`a2a_call`/`a2a_orchestrate`），入站只需 `A2A_PORT` + token。 | Hermes 节点两种接法都行：A2A（原生）与 ACP（`hermes-acp`）。控制面先吃 A2A，零改造。 |
| 6 | **opencode 有 headless server**：`opencode serve`（OpenAPI 3.1 `/doc`、默认 `127.0.0.1:4096`、`OPENCODE_SERVER_PASSWORD` Basic 鉴权、`GET /event` SSE、`POST /session/:id/permissions/:permissionID` 作答审批）；也有 `opencode acp`（其内部是自家 HTTP server 的 ACP 门面）。 | opencode 有两条腿：HTTP/SSE 适配器（功能最全）与 ACP-over-SSH（穿透最好）。 |
| 7 | **MCP 已改为无状态（2026-07-28）**：删掉了 `initialize` 会话握手，服务端主动请求改为 MRTR，SSE 断点续传被移除。 | **不要**把 MCP 当作控制面主干。MCP 只用于给 agent 挂工具。 |
| 8 | 业界的教训：**(a)** 不要把会话绑定在连接上（ACP 与 MCP 在"续传"上得出相反结论）；**(b)** 审批必须是可寻址、可恢复的资源，而不是阻塞的 stdin 读取；**(c)** 凭据留在工作节点，协议不搬运凭据；**(d)** 免入站端口要么靠 worker 主动长连接，要么靠 MCP-over-ACP。 | 见 §4 的四条设计原则。 |
| 9 | ACP 的 **Proxy Chains RFD** 已经定义了"中央 conductor + `proxy/successor`"。 | 控制面内核与 ACP 官方演进方向一致，未来可对齐。 |

---

## 3. 架构

```
        C 电脑（控制面）                             服务器 A / B ···（被管节点）
┌──────────────────────────────────┐
│  mesh CLI        mesh Web 控制台  │
│  ───────────────────────────────  │
│  Fleet（扇出 / 竞速 / 聚合）       │
│  Registry（节点注册表）            │
│  Store（任务 + 事件，可检索）       │
│  ───────────────────────────────  │
│  Adapters                          │
│   ├─ a2a       (HTTP JSON-RPC+SSE) │────HTTP───▶ Hermes A2A 端口
│   ├─ acp       (stdio JSON-RPC)    │────SSH────▶ hermes-acp / opencode acp / gemini
│   ├─ opencode  (HTTP+SSE /event)   │────HTTP───▶ opencode serve
│   └─ cli       (oneshot 子进程)     │────SSH────▶ 任意 CLI agent
└──────────────────────────────────┘
```

### 3.1 四条设计原则（来自调研）

1. **会话与连接解耦**：`Session`（对话上下文）与 `Connection`（进程/HTTP 连接）分开存。
   连接断了，会话仍在 Store 里，可 `resume`（对 A2A 用 `contextId`，对 ACP 用 `sessionId` + `session/load`）。
2. **审批是可寻址资源**：agent 要授权时不阻塞等 stdin，而是落库成一条 `approval` 记录，
   任务转入 `input-required`；C 上 `mesh approve <id> --allow` 再恢复。ACP 的
   `session/request_permission` 与 A2A 的 `INPUT_REQUIRED` 都映射到这一条通路。
3. **凭据只留在节点侧**：控制面只持有"访问节点所需"的令牌（A2A bearer、SSH key），
   不持有各 agent 的模型 API key——那是节点自己的事（对齐 ACP "agent-owned auth"）。
4. **默认安全**：ACP client 默认**不**宣告 `fs`/`terminal` 能力（agent 就会用自己的工具在服务器上干活）；
   审批默认 `deny`；SSH 主机指纹不跳过；A2A 无 token 不启用。
5. **密钥绝不落盘**（后续补充，因为编排 Agent 必须持有模型 key、而远端节点可能需要 SSH 密码）。
   两条通路，都保证 `nodes.json` 里没有可用凭据：
   - **SSH 密码**：只存**进程内存**（`Registry.setSecret`，独立的 `#secrets` 侧表，key 是节点 id），
     或者存一个**环境变量的名字**（`ssh.passwordEnv`）——密码本身在连的时候才从 `process.env` 读。
     两者都不会被 `save()` 序列化。代码通向适配器时走 `runtimeNode()`，它返回**副本**并附上密码，
     于是密钥拿得到、写不回。命令行**没有**任何携带密码的 flag。
   - **模型 API key**：同上，内存优先；`.agentmesh/llm.json` 只写 baseUrl / model / **变量名**。
   这条原则在验收里是被测试钉住的：`test/web.test.js` 断言密钥不会出现在 `nodes.json` 的原始字节里。

### 3.2 统一任务状态模型

以 A2A 状态机为基准，ACP 的 `stopReason` 与进程退出码映射进来：

| 统一状态 | A2A | ACP | 备注 |
|---|---|---|---|
| `queued` | — | — | 控制面本地已接受，待派发 |
| `submitted` | `TASK_STATE_SUBMITTED` | — | 已送达节点 |
| `working` | `TASK_STATE_WORKING` | `session/prompt` 进行中 | 有流式事件 |
| `input-required` | `TASK_STATE_INPUT_REQUIRED` | `session/request_permission` 待答 | 对应审批资源 |
| `auth-required` | `TASK_STATE_AUTH_REQUIRED` | 需要 `authenticate` | |
| `completed` | `TASK_STATE_COMPLETED` | `stopReason: end_turn` | |
| `failed` | `TASK_STATE_FAILED` | `stopReason: refusal/max_*` 或进程异常 | |
| `canceled` | `TASK_STATE_CANCELED` | `stopReason: cancelled` | |
| `rejected` | `TASK_STATE_REJECTED` | — | 防环/限流拒绝 |

---

## 4. 目录结构

```
D:\工作\
├─ PLAN.md                  本文件
├─ README.md                使用说明
├─ package.json             零依赖，type=module，bin: mesh
├─ bin/mesh.js              CLI 入口
├─ src/
│  ├─ protocol/             协议层（纯函数 + 线格式，无 IO）
│  │   ├─ util.js           id / 时间 / 小工具
│  │   ├─ states.js         统一状态模型与映射
│  │   ├─ jsonrpc.js        通用 JSON-RPC 2.0 对等端
│  │   ├─ acp.js            ACP v1 常量、nd-JSON 分帧、update 分类
│  │   └─ a2a.js            A2A v1.0 线格式（Card/Message/Task/SSE）
│  ├─ core/
│  │   ├─ registry.js       节点注册表（~/.agentmesh/nodes.json）
│  │   ├─ store.js          任务与事件持久化（node:sqlite）
│  │   ├─ fleet.js          派发、扇出、竞速、聚合；适配器缓存与失效
│  │   ├─ llm.js            OpenAI 兼容客户端（编排 Agent 的模型面）
│  │   ├─ orchestrator.js   编排 Agent：工具循环、审批、派发上限、干跑
│  │   ├─ transport/
│  │   │   ├─ spawn.js      本地子进程（stdio）
│  │   │   ├─ ssh.js        SSH 上的 stdio（含 askpass 密码通路）
│  │   │   ├─ net.js        只绑 fetch 肯连的端口（禁止端口列表）
│  │   │   └─ http.js       fetch + SSE 解析
│  │   └─ adapters/
│  │       ├─ acp.js        ACP 适配器（客户端角色）
│  │       ├─ a2a.js        A2A 适配器（JSON-RPC + SSE）
│  │       ├─ opencode.js   opencode serve 适配器
│  │       └─ cli.js        oneshot CLI 适配器（最低公共分母）
│  ├─ web/                  Web 控制台（HTTP + SSE + 单页 ui.html）
│  └─ cli/                  各子命令实现（main.js / args.js / render.js）
├─ test/                    node --test 测试（18 个文件）
├─ research/                调研语料与协议 schema（已 gitignore，用 tools/fetch.mjs 重新抓取）
└─ tools/                   验证与自检脚本（ssh-askpass、check-ui、verify-*）
```

---

## 5. 里程碑

| 阶段 | 内容 | 验收标准 | 状态 |
|---|---|---|---|
| M0 | 调研 + 协议 schema 固化 | 本地语料 `research/landscape.md` + `research/schemas/` 落地（已 gitignore） | 完成 |
| M1 | 协议层（states/jsonrpc/acp/a2a） | `node --test` 全绿 | 完成 |
| M2 | ACP 适配器 + 节点注册表 + Store + `mesh send` | **本机 Hermes 经 ACP 真实跑通一轮问答** | 完成（并被真机 NAS 取代验证） |
| M3 | A2A 适配器（Card 发现 + SendMessage + SSE） | **本机 Hermes 开 A2A 端口后真实跑通** + `mesh probe` 出卡 | 完成（对真实第三方公网 A2A 实现验证） |
| M4 | 扇出/竞速/聚合 + 任务历史 + 审批资源 | `mesh broadcast` / `mesh approve` 可用 | 部分：见下注 |
| M5 | opencode 适配器 + SSH 传输 | 本机起 opencode serve 跑通；SSH 通道打通 | 部分：SSH 已完成；opencode 仅有 mock |
| M6 | Web 控制台 | 浏览器看节点、发任务、看实时流 | 完成（**未经真实浏览器渲染**，见 ACCEPTANCE §5） |
| M7 | 文档、安装脚本、端到端验收 | `ACCEPTANCE.md` 记录真实输出 | 完成 |
| **M8** | **本地编排 Agent**（§1.1 的范围变更）：模型决定 → 派发 → 汇总 | 一句话驱动真实远端节点完成任务；干跑/审批/派发上限可用 | 完成 |
| **M9** | **控制面补全**（用户实测反馈驱动）：SSH 字段、节点编辑、密钥不落盘、模型配置面板 | 界面能表达一个完整节点；`nodes.json` 里无可用凭据 | 完成 |

**M4 的注**：`--mode first`/`all` 可用，但 `--mode best` **未实现**（行为等同 `all`）。
**M5 的注**：本机未安装 opencode，适配器只对着逐字节复刻其线格式的 mock 验证过。
两条都写在 ACCEPTANCE §5 的"未验证项"里，不当作已完成。

---

## 5.1 驱动力：缺陷驱动的补全

M9 不是计划出来的，而是**用真实环境跑出来的**。用户第一次真的去添加那台 NAS 时，报出四个问题
（界面没有用户名/端口字段、密码被写进了 `token` 并落盘、注册后无法编辑、探测失败不给原因），
每一个都在代码里得到确认并修复（ACCEPTANCE §4 的 36–38、39 等）。这条经验被固化成两件事：

1. **能表达，才算支持**：CLI 早就能表达一个完整节点，但界面不能——于是"能配"只对用 CLI 的人成立。
   现在两侧共用同一份注册表语义，并有测试钉住。
2. **报错要带上真正的原因**：`process exited (code=255)` 把 ssh 自己的话丢掉了，用户只能看到
   `UNKNOWN port -1`。现在适配器保留 ssh 的 stderr 尾部并并入关闭原因。

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 各 agent 的 ACP/A2A 实现有细节差异 | 适配器层做"宽容解析"（同时接受 v1.0 / v0.3 / 裸 payload），并把原始报文留档便于排障 |
| 远端未装 `hermes-acp`/`opencode` | `mesh probe` 先做能力探测；`cli` 适配器兜底 |
| 网络不可达（本机 HTTPS 就是坏的） | ACP-over-SSH 不依赖 HTTP；A2A 支持自定义 host/port；工具层用 Node 自带 TLS |
| 长任务丢连接 | Store 先落库再派发；事件流可重放（`mesh watch --replay`） |
| 审批被遗忘 | 审批记录带 TTL，超时自动 `cancel` 并标注 |

---

## 7. 与现有方案的关系

- **Hermes Kanban**（SQLite 看板 + dispatcher + 崩溃回收）是"同机多 worker"的强方案；
  本项目的差异点是**跨机器 + 异构 agent + 协议标准化**。两者可互补：把 Hermes 节点也当成一个 worker。
- **Zed / opencode / Claude Code** 的 ACP 面板都是"本地 IDE 连本地 agent"；本项目把 client 搬到 C，
  agent 留在服务器，并用 SSH 把 stdio 隧道过去。
- 不重造 A2A 服务端：能原生说 A2A 的节点（Hermes）直接用，只给不会说的节点写适配器。
