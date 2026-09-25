# AgentMesh 使用手册

> 这是**操作手册**：怎么装、怎么接节点、怎么发任务、怎么审批、出错怎么办。
> 规划与设计取舍见 [`PLAN.md`](PLAN.md)；验证过什么、没验证什么见 [`ACCEPTANCE.md`](ACCEPTANCE.md)。
>
> 本手册里的每条命令、flag 和配置项都**对照当前代码逐条核实过**。没实现的东西不写；
> 实现得不完整的东西会明确标注（例如 `--mode best`，见 §4.4）。

---

## 0. 它在做什么

你有多台机器，每台上面跑着不同的智能体（Hermes、opencode、Claude Code、Gemini CLI…）。
AgentMesh 让你在**一台**电脑上统一地给它们派活、看进度、批权限。

```
                        ┌──────────────────────────────────────┐
                        │  C：你的电脑                          │
                        │  mesh agent（本地编排 Agent）         │
                        │  mesh CLI  /  mesh serve(Web)         │
                        │  ├─ 节点注册表 nodes.json             │
                        │  └─ 任务/事件/审批  mesh.db           │
                        └───────────┬──────────────────────────┘
                                    │
                 ┌──────────────────┼──────────────────┐
                 │ SSH（免开端口）   │ HTTP              │ HTTP
                 ▼                  ▼                   ▼
        ┌────────────────┐  ┌──────────────┐  ┌──────────────────┐
        │ A：hermes-acp  │  │ B：A2A :9900 │  │ D：opencode :4096│
        │  stdio JSON-RPC│  │ Agent Card   │  │ /session + /event│
        └────────────────┘  └──────────────┘  └──────────────────┘
```

用起来有**两种姿势**，可以混着用：

* **你指定目标**：`mesh send <node> "<prompt>"` —— 明确、可预期、适合脚本和批处理。
* **你说意图**：`mesh agent "让 nas 上的 agent 写个函数"` —— 本机跑一个 Agent，**它自己判断**
  该派给哪台机器的哪个 Agent，然后把结果带回来（详见 §4.7）。

三条关键设计，决定了你怎么用它：

1. **不改造被管智能体。** 用它们**已有的**协议（ACP / A2A / HTTP）说话，服务器上不装 agent。
2. **会话与连接解耦，审批是可寻址资源。** 审批落库，能在另一个终端、甚至 Web 上作答。
3. **凭据留在节点侧。** 控制面只持有"访问节点所需"的东西（SSH 通道、token）。
4. **编排 Agent 是派发者，不是权限的绕过者。** 它能做什么由本机开关限制，远端能做什么仍由
   远端自己的策略决定（详见 §4.7.2）。

---

## 1. 环境要求与安装

| 项 | 要求 |
|---|---|
| Node | **≥ 22.5.0**（用到 `node:sqlite`、`node:test`、全局 `fetch`） |
| npm 依赖 | **零**。没有 `node_modules`，不需要 `npm install` |
| 操作系统 | 控制面在 Windows / macOS / Linux 均可（**只在 Windows 上实测过**，见 §11） |

三种用法，按需要挑：

```bash
# ① 直接跑（最省事，开发时用这个）
node bin/mesh.js help

# ② 用 npm script 的快捷方式
npm run mesh -- help

# ③ 装成全局命令 `mesh`
npm link            # 在仓库目录执行；之后任何地方都能用 `mesh help`
```

`mesh help` 会打印全部命令与 flag（本文档是它的扩展版）。

---

## 2. 五分钟上手

以本机已装好 Hermes 为例（Hermes 自带 `hermes-acp`，走 stdio，是最好走的路径）：

```bash
# 1) 注册一个节点（本机 = --local）
mesh node add hermes-local --kind hermes --local --cwd /path/to/your/project

# 2) 探测：握手 + 拿到 agent 名字/版本 + 它支持什么
mesh probe hermes-local
#   → ok  hermes-local: reachable
#     agent     hermes-agent v0.21.3
#     protocol  ACP v1
#     caps      loadSession=false streaming=true

# 3) 发第一个任务（回答写 stdout，进度写 stderr）
mesh send hermes-local "用一句话说明你现在的工作目录是哪里"

# 4) 打开 Web 控制台
mesh serve --port 7331        # 浏览器打开 http://127.0.0.1:7331
```

到这一步"一台机器上的一个智能体"就通了。要接第二台机器，看 §5。

---

## 3. 核心概念

### 3.1 节点（node）

一个"节点" = 一个可派发的智能体端点。它的配置（`nodes.json`）决定了**怎么连、连到哪、默认审批策略**。

```jsonc
{
  "id": "node_89012bcd28ca4942",
  "name": "nas-hermes",              // 你在命令里用的引用名
  "kind": "hermes",
  "transport": "acp",                // acp | a2a | opencode | cli
  "command": "/opt/hermes/bin/hermes-acp", // acp/cli：可执行文件
  "args": [],
  "cwd": "/srv/work",          // 会话工作目录（走 SSH 时是远端路径）
  "env": { "HERMES_HOME": "/tmp/mesh-hermes" },   // 随远端命令送达
  "approvalPolicy": "ask",           // deny | allow-once | allow-always | ask
  "capabilities": ["nas", "files"],  // 自由标签，供 broadcast 选择
  "tags": [],
  "enabled": true,
  "ssh": {                           // 有它就是远端，没有就是本机
    "host": "10.0.0.5",
    "user": "user",
    "port": 2222,
    "batchMode": false,
    "extraOptions": ["UserKnownHostsFile=...", "StrictHostKeyChecking=accept-new"]
  }
}
```

**引用名可以是 id 的前缀**：`nas-hermes`、`node_89012b` 都行。

### 3.2 四种传输（transport）

| transport | 适合 | 需要什么 | 审批能力 |
|---|---|---|---|
| `acp` | Hermes、Claude Code、Gemini CLI、任何 ACP agent | 一条 **stdio** 管道（本机直起，或经 SSH） | ✅ 完整（可挂起、可远程作答） |
| `a2a` | 开了原生 A2A 端口的 Hermes | HTTP 可达 + 可选 bearer token | ✅ 按 A2A 规范 |
| `opencode` | opencode headless server | HTTP 可达 + 可选 basic auth | ✅ |
| `cli` | **任何**只会命令行的 agent（兜底） | 一条命令 | ❌ **没有审批通道**（它不问，你也没得答） |

> `acp` 为什么走 SSH 而不是 HTTP：ACP 官方**只有 stdio 一种稳定传输**。
> 走 SSH 的好处是**服务器上不用开任何入站端口**，只要你能 ssh 上去就能管。

### 3.3 任务与统一状态

每次派发产生一条 task，状态是**统一模型**（以 A2A 状态机为基准，把 ACP 的 `stopReason` 映射进来）：

| 状态 | 含义 | 来源 |
|---|---|---|
| `queued` | 已落库，还没派出去 | AgentMesh 内部 |
| `submitted` | 已提交给对端 | A2A `TASK_STATE_SUBMITTED` |
| `working` | 正在干 | ACP `session/prompt` 进行中 |
| `input-required` | **在等人批权限**（挂起） | ACP `session/request_permission` |
| `auth-required` | 需要先认证 | A2A `TASK_STATE_AUTH_REQUIRED` |
| `completed` | 正常结束 | ACP `stopReason: end_turn` |
| `failed` | 失败 | `refusal` / 进程异常 / 超时 |
| `canceled` | 被取消 | `stopReason: cancelled` |
| `rejected` | 被拒 | A2A |

**退出码约定**：`mesh send` 与 `mesh broadcast` 只在**全部 `completed`** 时返回 `0`，否则 `1`。
所以脚本里可以直接 `if mesh send n "..." > out.txt; then ...`。

### 3.4 事件（event）

一次任务会流出这些事件类型，`--json` 模式下是 **NDJSON（一行一个 JSON）**：

`task-created` `task-state` `session` `chunk` `thought` `tool-call` `tool-update` `plan`
`usage` `approval-requested` `approval-resolved` `log` `error` `done`

- `chunk` 是**回答正文**。非 `--json` 模式下只有它写 **stdout**，其余进度写 **stderr** ——
  所以 `mesh send n "..." > answer.txt` 拿到的就是干净回答。
- `--json` 模式下**每个事件**都写 stdout，包含 `seq`（序号）。序号让消费方可以断点续传。

### 3.5 审批（approval）

agent 要执行敏感操作（改文件、跑命令）时会请求授权。由 `--approval` 决定怎么办：

| 策略 | 行为 | 需要人吗 |
|---|---|---|
| `deny`（**默认**） | 自动拒绝。agent 通常会给个"那我换个做法"的回答 | 否 |
| `allow-once` | 自动同意这一次 | 否 |
| `allow-always` | 自动同意，优先选 `allow_always` | 否 |
| `ask` | **挂起**任务（转 `input-required`），等你在 C 上裁决 | **是**，见 §6 |

`ask` 是唯一需要人的策略，也是这个项目存在的核心理由之一 —— 详见 §6。

---

## 4. 命令参考

通用：`--json` 机器可读输出，`--quiet` 压掉进度，`--help`。报错走 stderr 并以退出码 `1`
结束（用法错误/未知命令是 `2`）。

### 4.1 `mesh node` —— 管理节点

```bash
mesh node add <name> [options]   # 注册
mesh node edit <node> [options]  # 改字段（只改你传的那些）
mesh node list                   # 列表（表格）
mesh node show <node>            # 完整 JSON 配置
mesh node remove <node>          # 注销
mesh node check <node>           # 连通性 + 版本（等价于 probe）
```

`node add` 的选项：

| flag | 说明 |
|---|---|
| `--kind <preset>` | `hermes` \| `opencode` \| `gemini` \| `claude` \| `codex` \| `generic-acp` |
| `--transport <t>` | `acp` \| `a2a` \| `opencode` \| `cli`（不给则用 preset 的） |
| `--local` | 在本机起 agent（`acp`/`cli` 的默认） |
| `--ssh <host>` | 在远端起 agent（给了它就是远端） |
| `--ssh-user <u>` `--ssh-port <p>` `--ssh-key <path>` | SSH 目标 |
| `--ssh-binary <path>` | 换一个 ssh 客户端（如 plink） |
| `--ssh-binary-arg <a>` | **可重复**。放在 ssh 自身参数之前的参数 |
| `--ssh-batch-mode <y\|n>` | 默认 `yes`。`no` 仅用于**只接受密码**的主机（见 §5.3） |
| `--ssh-opt <o>` | **可重复**。原样透传 `-o`，如 `ProxyJump=bastion` |
| `--ssh-password-env <NAME>` | **密码放在环境变量 `$NAME` 里，注册表存的是这个名字**（见下方 §4.1.2） |
| `--command <cmd>` `--arg <a>` `--cwd <dir>` `--env K=V` | agent 的启动方式（`--arg`/`--env` 可重复） |
| `--url <url>` | `a2a`/`opencode` 的地址 |
| `--token <t>` | A2A bearer token |
| `--username <u>` `--password <p>` | opencode basic auth |
| `--approval <policy>` | 该节点的**默认**审批策略 |
| `--capability <c>` | **可重复**。供 `broadcast` 选择 |
| `--tag <t>` `--description <text>` | 备注用 |

> ⚠️ **值本身以 `-` 开头时必须用 `=` 形式**：`--ssh-binary-arg=-batch`。
> 写成 `--ssh-binary-arg -batch` 会报错并提示你改 —— 这是故意的，否则那个值会被
> 当成下一个 flag 而静默丢失。
>
> ⚠️ **可重复 flag 缺值会直接报错**（退出码 2）。`--node` 后面必须有节点名。

> ⚠️ **没写用户名 / 端口会明确警告。** `node add` 与 `node edit` 在你没给
> `--ssh-user` 或 `--ssh-port` 时会打印一行提醒：将要使用**本机账号**和 **22 端口**。
> 这不是多余的唠叨——"用本机用户名去连别人的服务器"是实际发生过的事故，
> 而它的症状（`Connection refused` / `banner exchange`）会把排查引向防火墙。

#### 4.1.1 `mesh node edit` —— 只改你传的字段

以前改一个字段只能**删掉重建**，而删掉会**丢掉节点 id**——id 是任务、事件、审批的外键，
于是历史记录要么被一起删掉、要么变成孤儿。现在：

```bash
mesh node edit nas-hermes --ssh-port 2222          # 只改端口
mesh node edit nas-hermes --ssh-user user --cwd /srv/work
mesh node edit nas-hermes --unset token             # 删掉一个字段
mesh node edit nas-hermes --unset ssh.passwordEnv --unset token   # 可重复
```

它会打印**字段级 diff**，让你看清到底改了什么：

```
  ssh.port: 22 → 2222
  unset: token
```

* **只改你传的字段**：`--ssh-port` 不会顺手把用户名或远端命令清空（这条有测试钉住）；
* `--unset <field>` **可重复**，支持点号路径（`ssh.passwordEnv`）；
* 长驻的 `mesh serve` 里改完配置会**立刻失效缓存适配器**，不会继续用旧配置——否则表现为
  "改了没生效"，而这类问题极难归因。

#### 4.1.2 密码怎么给：`--ssh-password-env`（推荐）

密码型主机（见 §5.3）有三种给法，按推荐顺序：

```bash
# ① 存变量名（推荐）：重启后仍然可用，而且什么都不落盘
$env:NAS_SSH_PW = '<密码>'
mesh node edit nas-hermes --ssh-password-env NAS_SSH_PW

# ② 运行时临时给：只活在这个进程的内存里，重启 mesh serve 就要重填
#    （控制面界面上那个密码框就是这条路径）

# ③ 清掉进程里已经持有的那份
mesh node edit nas-hermes --ssh-clear-secret
```

`--ssh-password-env` 之所以是推荐做法：注册表里存的是**变量名**（`ssh.passwordEnv`），
密码本身留在环境变量里，所以**磁盘上永远没有任何形式的密码**，重启后连接时再去读环境变量即可。
`--ssh-clear-secret` 只丢弃**当前进程内存里**持有的那份，不影响环境变量。

> ⚠️ **它会自动替你关掉 `BatchMode`，而这正是这份密码能被使用的前提。**
> ssh 在 `BatchMode=yes`（本项目的默认）下**拒绝使用密码**——所以指定了密码来源却仍留在
> BatchMode，等于配了一份**永远花不出去的凭据**，失败时只会说"提示没有东西可回答它"。
> 因此 `--ssh-password-env` **会自动把该节点的 `ssh.batchMode` 设为 `false`**；
> 你要是**显式**写了 `--ssh-batch-mode yes`，以你为准（明说就听你的）。
> 控制面（Web 界面）一直是这么做的，命令行以前不是——于是**同一个节点在界面里建就能用、
> 在命令行里建就不能用**（这就是缺陷 50）。现在两条入口的行为一致了。

> **没有**用来传密码本身的命令行参数，这是刻意的——命令行参数在同一台机器的其他进程眼里是公开的
> （`ps` / 进程列表）。有个测试专门断言"不存在这样的参数"。

### 4.2 `mesh probe` / `mesh node check`

```bash
mesh probe <node>          # 能力探测
mesh probe <node> --json
mesh node check <node>     # 同类检查，reachable===false 时退出码 1
```

探测做什么（取决于 transport）：

- `acp`：真的起进程并做 ACP `initialize` 握手 → 拿到 **agent 名称、版本、协议版本、认证方式、能力**
- `a2a`：抓 `/.well-known/agent-card.json` → 打印卡片的名称、版本、skills、流式/push/auth
- `opencode`：读 `/doc`（OpenAPI）**自检端点是否存在**，而不是硬编码猜

**接一个新节点，先 probe。** 它会把"连不上"和"连上了但对方不这么说话"区分开。

```console
$ mesh probe nas-hermes
ok  nas-hermes: reachable
  agent     hermes-agent  v0.18.0
  protocol  ACP v1
  caps      loadSession=false streaming=true
  auth      none advertised
```

### 4.3 `mesh send` —— 发一个任务

```bash
mesh send <node> "<prompt>" [options]
```

| flag | 说明 |
|---|---|
| `--continue` | 续接该节点**上一次**会话（多轮对话） |
| `--with-history` | 续接时**把既往轮次随消息一起发出**。给**不维护服务端上下文**的 A2A 对端用，见下方说明 |
| `--cwd <dir>` | 覆盖本次会话的工作目录 |
| `--approval <policy>` | 覆盖本次的审批策略（`deny`/`allow-once`/`allow-always`/`ask`） |
| `--timeout <ms>` | 提示词超时（默认等到底） |
| `--stream` / `--no-stream` | 强制开/关流式 |
| `--json` | 事件以 NDJSON 写 stdout |
| `--quiet` | 不打印结尾的状态摘要 |
| `--verbose` / `--logs` | 把 `log` 类型事件也打出来 |

```bash
# 干净回答进文件，进度在屏幕
mesh send hermes-local "总结这个仓库的架构" > answer.md

# 多轮：第二轮能记得第一轮（ACP/opencode 的会话连续性由 agent 自己维护）
mesh send hermes-local "把当前目录下的 README 读一下"
mesh send hermes-local "它讲了什么？" --continue

# A2A 对端不维护上下文时：由客户端把历史带上，否则第二轮它不记得第一轮
mesh send hermes-b-a2a "你好，我是从 C 电脑上的 AgentMesh 发来的"
mesh send hermes-b-a2a "我上一条说我自己来自哪里？" --continue --with-history

# 机器消费
mesh send hermes-local "列出所有 TODO" --json | jq -c 'select(.type=="chunk")|.text'
```

> **`--continue` 到底续的是什么？** 分两种情况，差别很大：
>
> - **ACP / opencode**：真的续。连接上带着 `sessionId`（或 opencode 的 session），
>   agent 自己记得之前说过什么，客户端什么都不用做。
> - **A2A**：`contextId` 只是**分组标签**。它能不能让 agent 记住上下文，取决于**对端有没有
>   按这个 id 去重建会话**。实测存在这样的对端：它收下并回传 `contextId`，但每次都新建 task、
>   只用最新那条消息构 prompt——于是"多轮对话"每一轮都是孤立的，**而且客户端看不出区别**
>   （第二轮它又自我介绍了一遍）。这种情况加 `--with-history`：客户端从本地库里取出该
>   `contextId` 的既往轮次，折叠成一段转录放在本次消息前面一起发出。
>
> 它**默认关闭**，因为对真正维护上下文的对端重复喂料是有害的（会把每一轮都说两遍）。
> 判断方法很简单：**问它一个只有记得上一轮才答得出的问题**（见 §5.4 的记忆测试）。

`--json` 时 stdout 是**纯 NDJSON**，可以直接喂给 `jq`。结尾状态摘要只在非 `--json` 且非 `--quiet`
时写 stderr：

```
completed  task=task_4f2a…  session=111cd57c-…  12.4s
```

### 4.4 `mesh broadcast` —— 扇出

```bash
mesh broadcast "<prompt>" [--node <n> ... | --capability <c>] [--mode all|first|best]
```

**目标选择规则**：

- 给了 `--node a --node b` → 就用这两个（显式 refs 优先）
- 否则按 `--capability` 选：节点 `capabilities` **或** `tags` 里含该标签就命中
- `--capability '*'` 或**完全不写** → 选中所有 `enabled` 的节点

```bash
mesh broadcast "各自报告一下磁盘占用" --node nas-hermes --node hermes-local
mesh broadcast "检查依赖有没有漏洞" --capability security
```

**`--mode` 的真实语义（务必看清）**：

| 值 | 实际行为 |
|---|---|
| `all`（默认） | 全部跑完，收集所有结果 |
| `first` | 并发跑，**一旦有一个完成且结果非空就停止再派发新的** |
| `best` | ⚠️ **当前等同于 `all`** —— 择优/评分逻辑没有实现，只是把结果按节点名排序 |

`first` 也不是严格竞速：它按并发池派发，所以"停止"前可能已经起了多个。

> `broadcast` **不接受** `--approval`/`--cwd`/`--timeout`：它使用**每个节点自己配的**
> `approvalPolicy`。要精细控制就单独 `mesh send`。

### 4.5 `cancel` / `tasks` / `task` / `watch` / `status`

```bash
mesh cancel <taskId> [--port 7331]         # 取消任务（见下方说明）
mesh tasks [--node <n>] [--state <s>] [--limit N] [--active]
mesh task <taskId> [--events]              # 单条详情；--events 附带完整事件日志
mesh watch [--task <id>] [--follow]        # 实时事件
mesh status                                # 节点数 / 任务数 / 待审批 / 事件总数
```

`task` **接受省略前缀**：`task_4f2a1b` 和 `4f2a1b` 都能查到。

**`mesh cancel` 有一条必须知道的规则：取消是经"活动连接"写回给 agent 的，所以只有持有该任务的
那个进程能真正叫停它。** 由此：

| 情形 | 行为 |
|---|---|
| 有 `mesh serve` 常驻且任务由它派发 | ✅ `mesh cancel <id>` 会 POST 给那个进程，真正取消 |
| 没有进程持有该任务 | ❌ **明确报错、退出码 1，并且不改任务记录**（不会假装成功） |
| 任务已经是终态（completed/failed/canceled） | ✅ 提示"已经是 X，无需取消"，退出码 0 |

```
$ mesh cancel task_7f76e6247c8d49ed
error: cannot cancel task_7f76e6247c8d49ed: no live connection holds it, and a cancellation is only
  delivered over that connection. The agent may still be working — this task is
  NOT marked canceled, because doing so would be a lie.
```

> 想跨终端取消，就让 `mesh serve` 常驻并由它发任务；或者用 Web 控制台的取消按钮
> （那个进程确实持有连接）。

> ⚠️ **`mesh watch` 的实时性有个坑**：它只订阅**自己这个进程**产生的事件。
> 也就是说，你在终端 A 里 `mesh send`，在终端 B 里 `mesh watch` 是**看不到**的。
> - 想看**历史**：`mesh watch --task <id> --follow`（会先回放已落库的事件）
> - 想看**实时**：用 `mesh serve` 发任务，然后开 Web 控制台的实时流（§7）
>
> 审批**不受这个限制** —— 它落库，任何终端都查得到、都能作答（§6）。

### 4.6 `approvals` / `approve`

```bash
mesh approvals [--all] [--limit N]         # 默认只看 pending
mesh approve <approvalId> [--allow|--deny] [--option <optionId>] [--port 7331]
```

`approve` 的 id 支持**前缀**。它**不是直接改数据库**，而是 POST 给正在运行的控制台进程
（`--port`，默认 7331）——因为只有**持有活动连接的那个进程**才能把决定写回 agent。
没有在跑的控制台时，它会明确告诉你这一点，并列出已知审批和可选 option。

### 4.7 `mesh agent` —— 本地编排 Agent（说得一句话，它自己去派活）

前面几条命令都是**你指定目标**（`mesh send <node> "<prompt>"`）。`mesh agent` 是另一种用法：
**在本机跑一个 Agent，你把意图用一句话讲给它，由它自己判断该派给哪台机器上的哪个 Agent。**

```bash
mesh agent "让 nas-hermes 写一个判断素数的 Python 函数，并把完整代码原样返回给我"
```

它的实际行为（真实运行，模型 `deepseek/deepseek-v4-pro`）：

```
orchestrator deepseek/deepseek-v4-pro · nodes: hermes-b-a2a, hermes-local, nas-hermes
→ send_task {"node":"nas-hermes","prompt":"请用 Python 写一个判断素数的函数，函数名为 is_prime…"}
  ✓ nas-hermes completed task=task_63b7357
nas-hermes 节点返回的完整代码如下：
```python
def is_prime(n):
    """判断整数 n 是否为素数，返回 True/False。"""
    if n < 2:
        return False
    …
```
— 2 step(s) · 1 dispatched · 1923 tokens
```

**回答进 stdout，过程和进度进 stderr**，所以 `mesh agent "…" > answer.md` 拿到的是干净答案。

```bash
mesh agent "现在有哪些节点可用？各自能做什么？"     # 单次
mesh agent                                        # 交互式会话（多轮，/help /nodes /exit）
mesh agent "…" --dry-run                          # 只出方案，不派发、不写库
mesh agent "…" --read-only                         # 工具集里根本没有派发工具
mesh agent "…" --tools list_nodes,probe_node       # 白名单；未知工具名直接报错
mesh agent "…" --confirm                           # 每次派发前问你一次
mesh agent "…" --max-steps 4 --max-dispatches 2    # 双重上限
mesh agent "…" --json                              # NDJSON 事件流（含 agent-final）
```

#### 4.7.1 先配置模型（必须）

编排器自己需要一个大模型来"做判断"。它**不绑定任何厂商**，只要一个 OpenAI 兼容端点：

```bash
# 方式一：环境变量
$env:AGENTMESH_LLM_BASE_URL = 'http://10.0.0.5:8000/v1'
$env:AGENTMESH_LLM_MODEL    = 'deepseek/deepseek-v4-pro'
$env:AGENTMESH_LLM_API_KEY  = '<key>'

# 方式二：存下来（推荐）
mesh agent save --base-url http://10.0.0.5:8000/v1 `
                --model deepseek/deepseek-v4-pro `
                --api-key-env MY_LLM_KEY       # 注意：这里填的是「变量名」，不是密钥本身
```

> **`save` 写的文件里永远没有密钥**，只有一个环境变量名：
> `{"baseUrl":"…","model":"…","apiKeyEnv":"MY_LLM_KEY"}`。密钥留在环境变量里，不落盘、不进备份、
> 不会被贴进工单。`--api-key <key>` 会被**明确拒绝**并说明原因——命令行参数在同机器的
> 其他进程眼里是公开的。

```bash
mesh agent config      # 看解析出来的配置（密钥只报「已设置，93 字符」，从不打印内容）
mesh agent models      # 这个网关到底能服务哪些模型（--filter 过滤）
```

优先级：`--base-url`/`--model` > `AGENTMESH_LLM_*` 环境变量 > `.agentmesh/llm.json`。

#### 4.7.2 它能用哪些工具、以及权限怎么改

编排器**只能**通过下面这六个工具动手，没有第七个：

| 工具 | 作用 | 是否需要"派发"权限 |
|---|---|---|
| `list_nodes` | 列出已注册节点及其能力 | 否（只读） |
| `probe_node` | 探测某节点能力（Agent Card / ACP 握手） | 否（只读） |
| `list_tasks` / `get_task` | 查历史任务与结果 | 否（只读） |
| `send_task` | 给一个节点派发任务 | **是** |
| `broadcast` | 给多个节点扇出同一任务 | **是** |

权限是**开关**，不是文档约定：

| 开关 | 效果 |
|---|---|
| `--dry-run` | 只出方案：不派发、不写库；模型被告知"你本来会发什么" |
| `--read-only` | 只暴露 4 个只读工具——派发工具**连出现都不出现**（不是"调用后拒绝"） |
| `--tools a,b` | 显式白名单，未知工具名**报错退出 1** 并列出全部合法工具 |
| `--confirm` | 每次派发前在终端问一次；**stdin 不是终端时默认拒绝**（无人值守的运行不能靠"提问没人答"蒙混过去） |
| `--max-steps` | LLM 轮数上限（默认 8）；触顶会明确报"没做完"并以退出码 1 结束，**不会给一个空答案冒充成功** |
| `--max-dispatches` | 单次运行实际派发的任务数上限（默认 8） |

**有一条它刻意不覆盖**：节点自己的 `approvalPolicy`。编排器是**派发者，不是权限的绕过者**——
远端 agent 能做什么，仍然由远端自己的策略决定，编排器只能把结果（包括拒绝）如实带回来。
实测中 NAS 节点配的是 `ask`，无人应答时默认拒绝写盘，编排器就照实转述："远端代理在返回时注明，
它拒绝了写文件和运行验证，所以这段代码未经实际执行验证。"

#### 4.7.3 Web 控制台里的同一个 Agent

`mesh serve` 之后，控制台**第二行（通栏）**就是对话面板（第一行是节点列表与注册表单）：输入一句话
点"交给它办"，它的思考、每次工具调用、每次派发、最终答复都会实时逐条显示（走 SSE）。
"只出方案不执行（dry-run）"是个勾选框。**模型配置折叠在这个面板的底部**，
点开就能填 API 地址、模型、密钥（见 §7.3）。
控制面接口是 `POST /api/agent`，与 CLI **复用完全相同的 `runAgent()`**。

> Agent 的**推理不落库**，它**派发出去的任务**落库。推理是过程、会过期；动作是审计对象、必须可查。
> 所以你在"最近任务"里看到的，和手工 `mesh send` 发出去的任务长得一模一样。

#### 4.7.4 它为什么不会"编造成功"

LLM 有把失败描述成成功的天然倾向，而这个功能的用途恰恰是**代你操作别的机器**。所以：

* 工具失败**作为数据回喂给模型**，让它自己纠正（比如节点名写错），而不是中断整次运行；
* 系统提示明确要求它**必须原样引用**远端答复，且**不得声称自己做了没做的事**；
* 派发失败时它拿到的是真实错误原文（实测拿到过 `spawn EPERM`、`remote agent exploded`）。

实测过一次典型的失败路径：派发失败 → **自动重试一次** → 仍失败 → 回答"我没有伪造结果，也不会
再静默重试"，给出排查方向，并主动提出可以改派给其他节点。

### 4.8 `mesh serve` —— Web 控制台

```bash
mesh serve [--port 7331] [--host 127.0.0.1] [--open]
```

> 🔴 **控制台没有认证。** 默认 `--host 127.0.0.1` 意味着只有本机能连，**请保持这个默认值**。
> `--host 0.0.0.0`（或任何非回环地址）会把"增删节点 / 派发任务 / 批准审批"这套能力
> 无认证地开放给所有能连上该端口的人——而被派发的任务会在远端主机上执行命令。
> 远程访问请用 `ssh -N -L 7331:127.0.0.1:7331 user@host`，把认证交给 SSH。
> 完整威胁模型见 [`SECURITY.md`](SECURITY.md)。

它同时是**审批的持有者**和 **HTTP API 服务**，详见 §7。

> ⚠️ **不要把端口设成 `0`，也不要设在 fetch 的禁止端口上。**
> `--port 0` 会让操作系统随便挑一个空闲端口，其中有 82 个端口（`sane-port` 6566、X11 6000、
> IRC 6667 等）**是 WHATWG fetch 规范禁止连接的**。端口本身是好的（`curl` 能连），
> 但 Node 的 `fetch()` 会直接拒绝，报 `fetch failed (bad port)`。
> 结果是：你得到一个**真的在监听、但所有用 fetch 的客户端都不肯连**的控制面——
> 浏览器能打开，而 `mesh send` / 控制台里那些走 `fetch` 的路径会莫名其妙地失败。
> 同理，**把节点配在这些端口上**（`--ssh-port 6667` 之类）也会得到"连不上但说不清为什么"的效果。
> 项目内部起临时服务器时用的是 `listenOnFetchablePort()`（拿到禁止端口就关掉重掷），
> 这就是为什么测试不再随机挂——见 `ACCEPTANCE.md` 缺陷 46。

### 4.9 `mesh secrets` —— 让密码跨重启保留

```bash
mesh secrets list                    # 只看名字，永不显示值
mesh secrets set NAS_SSH_PW          # 交互式输入（不回显）
mesh secrets set NAS_SSH_PW --stdin  # 从管道读
mesh secrets rm NAS_SSH_PW
mesh secrets path                    # 打印文件路径
```

存在 `~/.agentmesh/secrets.env`（权限 `0600`，**明文**），启动时自动加载进环境变量。节点里仍然填**变量名**（`--ssh-password-env NAS_SSH_PW`）。`list` 会区分 `in effect` 与 `shadowed by the environment`（真实环境变量优先）。

**明文落盘是权衡后的选择，前提是文件权限；更优解是改用 SSH 密钥。** 完整说明见 §7.4。

### 4.10 `presets` / `help` / `version`

```bash
mesh presets        # 内置 agent 预设及其默认 command/transport/审批策略
mesh help
mesh --version      # 打印版本与状态目录
```

### 4.11 `mesh auth` —— 谁能打开控制台

```bash
mesh auth                              # 列出账号（默认就是 list）
mesh auth add yanyu                    # 建账号，密码隐藏输入、要输两遍
mesh auth passwd yanyu                 # 改密码；旧会话立刻失效
mesh auth remove yanyu                 # 删账号；最后一个账号删不掉
mesh auth path                         # 账号文件路径
echo -n 'a-long-password' | mesh auth add ci-bot --stdin   # 不用 TTY 的写法
```

**密码存的是 scrypt 哈希，不是明文，也拿不回来。** 这与 §4.9 的 SSH 密码刚好相反，而且是刻意的：
SSH 密码必须能还原（要交给 `ssh`），所以只能明文放进 0600 的文件；而登录密码只需要**校验**，
没有任何地方需要把它读回来，所以存不可逆的更安全、且不花任何代价。两件事要是共用一个文件，
就只能按更弱的那条规则来。

**没有 `--password` 参数**：命令行参数是本机任何进程都能通过 `ps` 读到的，也会进 shell 历史。
要脚本化就用 `--stdin`。

---

## 5. 接入配方

### 5.1 本机 Hermes（ACP，最简单）

```bash
mesh node add hermes-local --kind hermes --local --cwd /path/to/project
mesh probe hermes-local
mesh send hermes-local "say hello"
```

`--kind hermes` 会自动带上 `command: hermes-acp` 与 `approvalPolicy: deny`。

### 5.2 远端 Hermes（ACP over SSH，免开端口）

```bash
mesh node add hermes-b --kind hermes --ssh 10.0.0.5 --ssh-user root --cwd /srv/work
mesh probe hermes-b
mesh send hermes-b "在 /srv/work 下创建一个说明文件"
```

要求：`hermes-acp` 在远端 `PATH` 里（不在就用 `--command /full/path/hermes-acp`）。

**节点级环境变量**会随远端命令一起送达（`cd <cwd> && exec env K=V <cmd>`）：

```bash
mesh node add hermes-b --kind hermes --ssh 10.0.0.5 \
  --env HERMES_MODEL=deepseek/deepseek-v4.1-flash --env HOME=/srv/hermes
```

需要跳板机或自定义 `known_hosts`：

```bash
mesh node add hermes-b --kind hermes --ssh 10.0.0.5 \
  --ssh-opt ProxyJump=bastion \
  --ssh-opt UserKnownHostsFile=/etc/agentmesh/known_hosts \
  --ssh-opt StrictHostKeyChecking=accept-new
```

### 5.3 只接受密码的远端主机（进阶）

**为什么不能直接输密码**：ACP 的稳定传输**就是 stdio**，而 SSH 的密码提示会去读 stdin ——
那正是协议管道。所以默认 `BatchMode=yes`，永远不提示。

密码型主机走 `SSH_ASKPASS`：让**助手程序**回答提示，stdin 就干净了。Windows 上唯一通用的
助手解释器是 `node.exe`，而它需要 `NODE_OPTIONS=--require` 才能充当助手 —— 但**这个变量会被
子进程继承**，直接 export 的话 `mesh` 自己会把密码打到 stdout。所以仓库里给了一层
**只作用于 ssh 子进程**的包装器：

```powershell
# 密码只存在于环境变量里，不写进 nodes.json、不落盘
$env:MESH_ASKPASS_SECRET = '<password>'

mesh node add nas --kind hermes --ssh 10.0.0.5 --ssh-user me --ssh-port 2222 `
  --ssh-batch-mode no `
  --ssh-binary "<node.exe 的完整路径>" `
  --ssh-binary-arg "<仓库>\tools\ssh-askpass.mjs" `
  --ssh-binary-arg "C:\Windows\System32\OpenSSH\ssh.exe" `
  --ssh-opt "UserKnownHostsFile=<仓库>\.ssh\known_hosts" `
  --ssh-opt "StrictHostKeyChecking=accept-new" `
  --command /opt/hermes/bin/hermes-acp `
  --cwd /srv/work `
  --env HERMES_HOME=/tmp/mesh-hermes --env HOME=/tmp/mesh-hermes `
  --approval ask
```

之后每条命令都要带上 `$env:MESH_ASKPASS_SECRET`。

> 也可以用 `MESH_ASKPASS_SECRET_FILE=<path>` 从文件读密码。
>
> **这是接线用的权宜方案。能装公钥就装公钥**（`--ssh-key`），那样可以回到默认的
> `BatchMode=yes`，也不必再把密码放进环境变量。真实 NAS 的完整实测记录见
> [`ACCEPTANCE.md`](ACCEPTANCE.md) 第 3.6 节。

### 5.4 远端 Hermes 原生 A2A

```bash
# 在 B 服务器上：
A2A_PORT=9900 A2A_HOST=0.0.0.0 A2A_AGENT_NAME=hermes-b A2A_BEARER_TOKEN=<secret> hermes gateway run

# 在 C 上：
mesh node add hermes-b --transport a2a --url http://10.0.0.5:9900 --token <secret>
mesh probe hermes-b          # 会打印 Agent Card 的名称、能力、skills
mesh send hermes-b "你好"     # 派发一个任务
```

优点：不需要 SSH、被管端不需要装东西。代价：**要在服务器上开入站端口**。

> **端口填在哪里：写在地址里，没有单独的"端口"框。**
> A2A 是 HTTP，**地址本身就带端口**：控制台里填在「**端点 URL**」，CLI 里是 `--url`。
> 表单里那个「**SSH 端口**」框属于 **SSH**，只在 `acp` / `cli` 传输下出现——`a2a` / `opencode`
> 时整块 SSH 字段是**隐藏的**，因为那种情况下根本不需要 ssh 到那台机器。
> 所以 `http://104.233.150.240:9900` **就是**正确的写法，不是"没地方填端口"。
> 反过来说：**能填端口的地方只有两处**，`--url` / 端点 URL（HTTP 类）与 `SSH 端口`（SSH 类），
> 你在哪一类传输下就只会看到对应的那一处。

> **`A2A_HOST=0.0.0.0` 与"端口真的开了"是两件事。** 若被管端在云上，除了进程监听
> `0.0.0.0`，**云安全组还要放行 9900 的入站 TCP**，主机防火墙（`ufw`/`firewalld`/`iptables`）
> 也可能再挡一层。这两层任缺其一，症状都是"连不上"，但**原因和处置完全不同**——
> 先看下面的「连通性自检」，它一次就能区分开。

**连通性自检**（`mesh probe` 报错前先跑这个，它会直接给出结论）：

```bash
node tools/verify-a2a.mjs --url http://123.56.124.199:9900 --token <secret>
```

**三种结局的含义**（判据很硬：**放行会得到拒绝（RST），拦截只会得到沉默**）：

| 结果 | 说明什么 | 该动哪里 |
|---|---|---|
| `connected` | 端口通 | 问题在协议的下一层（卡片/RPC），看下面第 1、2 节 |
| `refused` | **包到了主机**，但没人监听。安全组是**放行**的 | 启动被管端进程，或检查它的 `A2A_HOST` 是不是写成了 `127.0.0.1` |
| `timed out / dropped` | **包在到达主机之前就被丢了**。安全组（云）或主机防火墙没放行 | 在**云控制台的安全组**加入站 TCP 规则；再查 `ufw`/`firewalld`/`iptables` |

> `refused` 与 `timed out` **必须分开看**：`refused` 说明网络是通的、问题在被管端自己；
> `timed out` 说明网络不通、**在被管端上做任何事都不会有效果**。分不清这一点，就会去
> 服务器上反复重启进程，而真正要改的是云安全组。同一个云主机上同时看到 `443 connected`、
> `80/22 refused`、`9900 timed out`，结论只有一个：**主机活着、安全组在丢 9900 的包**。

它先做一次裸 TCP 连接再拉 Agent Card，失败时明确区分：

```
FAIL TCP connect  timed out after 8s (packets are being dropped, not refused)
FAIL card fetched  cannot reach http://…/.well-known/agent-card.json: UND_ERR_CONNECT_TIMEOUT
                   — … a firewall or cloud security group is DROPPING packets to this port
                   (a merely-closed port would be refused instead)
```

全绿时长这样（对一个真实对端的实测输出）：

```
0. transport reachability
  ok   TCP connect  connected
1. Agent Card discovery (live endpoint)
  ok   card fetched  hermes-b v0.14.0
  ok   card declares an interface (v1.0 binding or legacy url)  legacy
  ok   an RPC endpoint was resolved  http://123.56.124.199:9900
2. a real task
  ok   task completed  state=completed
  ok   a response came back  "[hermes-b placeholder] received 20 chars: 'hello from AgentMesh' — connectivity OK."
```

**两个已知的真实互操作坑**（都已被客户端吸收，但知道它们能省你很多时间）：

1. **卡片里写的是内网地址。** 若 agent 在 NAT/VPC 之后，它的 Agent Card 常会报自己的内网
   地址（例如 `http://172.24.225.207:9900/`）。AgentMesh 检测到"宣告的是私网地址、且与取到
   卡片的地址不同"时，会**改用取到卡片的那条已证实通路**，并在 `mesh probe` 里打一条 `!` 告警。
   根治办法是在对端设置它的对外 URL；告警里会写明这一点。
2. **对端只说 v0.3 的方法名。** 老一些的对端只实现 `message/send`，对 `SendMessage` 回
   `-32601 Method not found`。AgentMesh 会按卡片宣告的协议版本选方法名，并在 `-32601` 时
   **自动换另一套重试一次**，所以这一条你通常不会感知到。
3. **对端不维护会话上下文（最常见、也最隐蔽）。** 它收下并回传 `contextId`，但每轮都当新对话
   处理。表现是"看起来在对话，其实每轮都失忆"——你一追问它就露馅。用 `--with-history`。

**多轮对话的记忆测试**（判断第 3 条最快的办法）：第二轮问它一个只有记得第一轮才答得出的问题。

```bash
mesh send hermes-b "记住这个数字：7391。请只回复'已记住'。"
mesh send hermes-b "我刚才让你记的数字是多少？" --continue --with-history
```

如果**不加** `--with-history` 时它答不上来、**加上**就能答对，说明对端不维护上下文。
（真实的第三方对端上就是这样：不加时它明确回答"此前轮次未进入我的会话上下文"。）

**不想动安全组？** 若该服务器已有 nginx 占着已放行的 80/443，可以反代过去，不必新开端口：

```nginx
location /a2a/ { proxy_pass http://127.0.0.1:9900/; proxy_buffering off; }
```

```bash
# 注意结尾的 /a2a：AgentMesh 会在基址之后拼 /.well-known/agent-card.json
mesh node add hermes-b --transport a2a --url http://123.56.124.199/a2a --token <secret>
```

`proxy_buffering off` 不能省：A2A 的流式响应是 SSE，缓冲会让它变成"一次性吐出"。

### 5.5 opencode

```bash
# 在 A 服务器上：
OPENCODE_SERVER_PASSWORD=<pass> opencode serve --port 4096 --hostname 0.0.0.0

# 在 C 上：
mesh node add oc-a --transport opencode --url http://10.0.0.6:4096 --password <pass>
mesh probe oc-a              # 用 /doc 自检端点，不靠硬编码猜测
```

### 5.6 任何 ACP agent

```bash
# 例：Gemini CLI 的 ACP 模式
mesh node add g --transport acp --local --command gemini --arg --experimental-acp

# 例：Claude Code 的官方 ACP 适配器
mesh node add cc --transport acp --local --command claude-agent-acp

# 例：远端任意 ACP agent
mesh node add ga --transport acp --ssh host --command /opt/agent/acp-server --cwd /srv
```

### 5.7 兜底：只会 CLI 的 agent

```bash
mesh node add legacy --transport cli --ssh 10.0.0.7 \
  --command "my-agent" --arg "--yes" --arg "{prompt}"
```

- `{prompt}` 会被替换成实际提示词
- **不写占位符**则把 prompt 追加为最后一个参数
- 也可以通过 stdin 投喂：在节点配置里加 `"promptVia": "stdin"`

> ⚠️ `promptVia` **没有对应的 CLI flag**，只能手改 `nodes.json`，或用 Web 控制台注册
> （`POST /api/nodes` 接受完整配置对象）。
>
> ⚠️ `cli` 传输**没有审批通道** —— 它不会问你，你也批不了。这一点在文档早期版本里
> 曾被写成一个不存在的 `--prompt-via` flag，已更正。

---

## 6. 远程审批完全指南

这是整个项目最值得用的部分：**智能体在远端要动手，你在本地决定放不放行。**

### 6.1 三种作答方式

**方式一：CLI 就地交互（前台、有 TTY）**

```bash
mesh send nas-hermes "把结果写入 /srv/work/report.md" --approval ask
```

策略是 `ask` **且** stdin 是 TTY 时，CLI 会在 stderr 上弹出选项让你输数字：

```
⚠️  approval required: Approve edit: /srv/work/report.md
   [1] Allow once (allow_once)
   [2] Reject once (reject_once)
choose (number), or Enter to deny:
```

**方式二：常驻控制台 + 另一个终端裁决（推荐）**

```bash
mesh serve --port 7331 &          # 由它持有活动连接
mesh send nas-hermes "写入报告" --approval ask
# 任务挂起，转 input-required
mesh approvals                    # 看到 APP id 和 agent 给的原始理由
mesh approve appr_4b9384ac --allow
```

**方式三：Web 控制台点按钮** —— 待审批面板里直接点，见 §7。

### 6.2 必须理解的一点：谁持有连接

审批的**写回**只能由**持有那条活动连接的进程**完成。所以：

| 场景 | 结果 |
|---|---|
| `mesh serve` 常驻，任务由它派发 | ✅ 任何终端的 `mesh approve` 都能裁决 |
| 前台 `mesh send --approval ask`（有 TTY） | ✅ CLI 就地交互 |
| 前台 `mesh send --approval ask`（**无 TTY**，如 CI） | ❌ 会挂起直到超时。此时没有进程能接收你的裁决 |
| 任务所在进程已退出 | ❌ `mesh approve` 会明确告诉你"没有活动连接持有它" |

`mesh approvals` 查的是**数据库**，所以历史与当前 pending 都能看到；
但能不能**作答**取决于连接是否还活着。

### 6.3 超时

挂起的审批默认 **15 分钟**后自动按"取消"回执，避免 agent 永久卡住。
（可由节点配置的 `approvalTtlMs` 调整；`mesh send --timeout` 控制的是提示词本身。）

### 6.4 一个真机上的意外（值得知道）

在 Hermes 上通过 **shell 命令书写中文**会触发审批：Hermes 自带的 `tirith` 预执行扫描会把
"文本里混有 Unicode 与 ASCII"判成 `[HIGH] Confusable Unicode characters`（疑似同形字攻击）。
在我们实测的场合这**是误报**，但结果是：**含 CJK 的 shell 写入命令会弹审批**。
要么用 `ask` 人工放行，要么让 agent 走非 shell 的写入通道。

### 6.5 远端智能体要权限时，到底走哪条路

这一节回答一个很容易搞混的问题：**"本机的审批控制，是不是只对本机智能体有效？"**

先把两件不同的事分开——它们都叫"权限"，但不是一回事：

| | 管什么 | 在哪执行 | 和远端有关吗 |
|---|---|---|---|
| **派发闸门** | 我们**自己**能不能把这个任务派出去：`--approval`、`--read-only` / `--tools`、`--max-steps`、`--max-dispatches`、`dryRun` | 本机，**在请求离开之前** | 无关。它管的是我们的动作，不是远端的动作 |
| **远端索要权限** | 远端在执行过程中停下来问"这条命令我能执行吗" | 远端发起，**本机裁决** | 有关，而且**这是协议能力**，不是本机策略 |

所以答案不是"只适合本地"：**远端要权限这件事，取决于那条传输有没有这条通道**。

| 传输 | 远端能索要权限吗 | 状态 |
|---|---|---|
| **ACP** | ✅ `session/request_permission` | **已完整实现**：远端弹问 → 本机「待审批」面板 / `mesh approve` → 回执送回远端；有 TTL、有审计行。见 6.1–6.3 |
| **opencode** | ✅ 它自己的 permission 请求 | **已实现**（同样是选项式） |
| **A2A** | ⚠️ 只有 `TASK_STATE_INPUT_REQUIRED` | 状态能识别，但**没有选项集**可渲染：它要的是**自由文本**，不是 o/s/d 三选一 |
| **cli / 其它** | ❌ 没有通道 | 子进程里弹什么都是它自己的本地行为，本机看不到 |

**为什么 ACP 是审批链路的正确选择**：ACP 的权限模型**本来就是选项式**的（remote 给出选项列表，我们选一个），所以它能直接放进「待审批」面板变成按钮。A2A 的 `input-required` 要的是**一段自由文本**——它的回答方式是"在同一个 `contextId` 里再发一条消息"，也就是本项目的 `--continue`。**这是协议形态的差别，不是实现疏忽**：把自由文本硬塞进按钮式的面板，会做出一个按下去却带不出你要说的话的按钮。

#### A2A 节点停下来等你的样子

远端返回 `input-required` 时，你会**明确看到**（而不是只看到一个状态名）：

```text
────────────────────────────────────────────────────────────
input-required  task=task_a731f3b4  context=ctx-1  145ms
远端在等你回应 —— 它没有失败，是停下来等人做决定。
它问的是：
  ⚠️ DANGEROUS COMMAND: Security scan — [MEDIUM] Multiple credential files accessed
  rm -rf /srv/work/tmp/*
回答它（会带着同一个会话发回去）：
  mesh send hermes-b "<你的回答>" --continue
```

- **命令行**：照上面那行做。`--continue` 会带上同一个 `contextId`，对端才认得出这是对刚才那个问题的回答。
- **Web 控制台**：实时事件里会出现一条醒目的黄线，附一句「在下面『给指定节点发任务』里选同一个节点，勾上『续接上次会话』，把回答填进去再发送」——**控制台本身就能回答它**，不用开终端。
- 这次如果没拿到 `contextId`，两边都会提醒你：`--continue` 可能会开一段**新会话**，对端未必能把它接上。

#### `--approval` 打在 A2A 上会怎样

**它会明确告诉你这个开关在这条传输上没有作用**，而不是默默忽略：

```text
log  --approval ask has no effect on the 'a2a' transport: it has no permission channel.
     ACP carries session/request_permission and opencode has its own, but A2A only reports
     TASK_STATE_INPUT_REQUIRED, which stops the task and waits for a follow-up message.
     Use an ACP node for approvals, or answer with: mesh send <node> "<answer>" --continue
```

静默忽略一个"请求被咨询"的开关，会让人以为自己在场就能被问到——而真正需要人的那一刻什么都没发生。所以这里宁可吵一句。

#### 如果对端**根本不说话**呢（比如一个只包了 CLI 的 A2A 服务）

这是实际遇到过的情况：对端是个 Flask/HTTP 包装层，它在内部 `subprocess` 里跑 `hermes chat -q`，安全扫描的审批提示发生在**那个子进程的 stdin/stdout 上**，而包装层从来没有把它翻译成 A2A 的 `input-required`。于是：

- 对端会一直**阻塞**在那个提示上，直到它自己的超时，然后按默认值**拒绝**；
- 本机看到的只是一段"被拒绝"的文字，**没有任何信号说"有人本来可以放行"**；
- 观感就是"任务卡死 / 指令消失"。

**这件事本机修不了**，因为令牌从来没被发出来过。**正确做法是让对端说协议，而不是让本机去扒对端的终端**——"PTY 接管"（去扫子进程输出、认出 `Choice [o/s/D]:`、再回写 stdin）是**对端那一侧**的改造，而且是在重造一个协议里已经有的东西。两条更省事的路：

1. **改用 ACP 连它**（推荐）。Hermes 有原生 ACP，本项目有一条**验证过的 ACP over SSH** 通路，**不需要在对端开任何端口**，而且审批链路是现成的、有 UI 的：见 §5.2 / §5.3。实测过的那台就是这样接的。
2. 如果必须走 A2A，就让**对端**把待批命令作为 `TASK_STATE_INPUT_REQUIRED` + `status.message` 发出来（问题原文放在 message parts 里），本机这边已经会把它醒目地呈现并给出回答方式。

---

## 7. Web 控制台与 HTTP API

```bash
mesh serve --port 7331
# → AgentMesh console  http://127.0.0.1:7331
```

控制台能做：看节点、一键探测、表单注册与**编辑**节点、给指定节点发任务、选审批策略、续接会话、
取消任务、**实时事件流**（SSE，断线自动从 `?after=<seq>` 续传）、**待审批面板**（点按钮作答）、
最近任务表、本地编排 Agent 的对话面板、以及**编排 Agent 的模型配置**。

#### 页面从上到下

| 区域 | 位置 | 里面是什么 |
|---|---|---|
| 顶栏 | 固定在最上（毛玻璃） | Logo + 连接状态 + 节点 / 任务 / 待审批 / 事件 四个计数 + 刷新按钮 |
| **编排 Agent** ‖ **待审批** + **节点** | 第一行（左宽右窄） | 左边是对话面板：说一句话，它自己决定派给谁，**模型配置折叠在本面板底部**；右边上面是等你点按钮的审批，下面是已注册节点列表（每行「编辑 / 探测 / 删除」） |
| **给指定节点发任务** | 第二行，通栏 | 直接指定一个节点派活，可选审批策略、续接会话、共享上下文 |
| **注册 / 编辑节点** | 第三行，通栏，**整面板可折叠**（点标题行收起；点节点的「编辑」会自动展开并回填） | 按传输方式自适应的注册表单 |
| **实时事件** ‖ **最近任务** | 第四行 | 左边是 SSE 事件流，每行按事件类型着色；右边是任务表，状态是彩色徽章 |

顺序是刻意的：**日常最多用的是「说人话派活」和最要紧的审批，所以它们在第一屏；表单只在增改节点时才需要，可以整张收起；流水与历史沉底。**
对话面板里，你的话是右侧的气泡，答复是左侧的卡片，中间的思考与工具调用默认折叠成一行「过程」摘要（可展开，见 §7.3 下方的显示选项）。

### 7.1 注册节点表单：按传输方式自适应，并且分组了

表单**不再**是一长串没有边界的输入框，而是四个**带标题的分组**。每个框的**正上方**是 2–6 个字的
短标签，**正下方**是灰色小字的说明——例如原来那个
「密码 —— 只存在服务进程内存里，不写进任何文件」的整句标签，现在标签只留「SSH 密码」，
其余变成下面的说明。另外，**哪个框获得焦点，它自己的标签就会变色**：同屏二十个框时，
这是判断"这个标签究竟属于哪个框"最快的一条线索。

| 分组 | 里面是什么 |
|---|---|
| **1 · 它是什么** | 节点预设、传输方式、节点名称 |
| **2 · HTTP 端点** | 地址（URL） |
| **2 · SSH 连接** | 主机、用户名、SSH 端口、远端命令、远端工作目录、认证方式；认证方式选「密码」后**追加**「SSH 密码」与「或：密码所在的环境变量名」两个框 |
| **高级选项**（默认折叠） | 审批策略、SSH 私钥文件、额外 `ssh -o`、节点环境变量、token |

两个「**2 ·**」分组是**互斥**的，选了什么传输方式就只出现哪一组，切换时立即重排：

| 传输方式 | 显示哪一组 | 需要填什么 |
|---|---|---|
| `acp` / `cli`，**主机留空** | SSH 连接 | 名称 / 远端命令 / 工作目录（主机留空 = 就在本机跑） |
| `acp` / `cli`，填了主机 | SSH 连接 | 名称 / **主机 / 用户名 / SSH 端口** / 远端命令 / 工作目录 / 认证方式 |
| `a2a` / `opencode` | HTTP 端点 | 名称 / 地址（URL）；token 在「高级选项」里 |

「主机」下面那行说明写着**留空 = 就在本机运行**——这不是装饰：本机节点和远程节点走的是同一个
传输方式，区别只在主机是否留空。

**为什么强调这个**：早先的表单只有 5 个框，**没有用户名、没有端口、没有远端命令路径**，
而预设又强制决定传输方式。如果你的 sshd 不在 22 端口、用户名也不同于本机账号
（比如一台 NAS：sshd 在 2222、用户 `user`），**那个表单按设计就注册不出可用的节点**——
它只能发出 `ssh:{host}`，于是 ssh 拿本机用户名和 22 端口去连，报
`banner exchange: Connection to UNKNOWN port -1: Connection refused`。
这个报错会把人引向防火墙，而真因是"表单缺字段"。（这是缺陷 36 的形态，已修复。）

### 7.2 编辑节点与隐患提示

每一行节点都有「编辑」按钮：点了会把该节点的现有配置**回填进表单**，改完只提交你动过的字段
（与 `mesh node edit` 同一条后端路径）。以前改一个字段只能删掉重建，而删掉会**丢掉节点 id**——
那是任务/事件/审批的外键。

节点行还会**直接把隐患标出来**，而不是留给你去猜：

```
无用户名→用本机账号      没填 ssh.user，连接时会用跑 mesh serve 的那个账号
无端口→22               没填 ssh.port，会去连 22
需要密码但拿不到         该节点要密码（BatchMode=off），而进程里现在没有
```

这三条都是**具体发生过**的事故形态，所以它们显示在列表里，而不是等你探测失败再猜。

### 7.3 编排 Agent 的模型面板

它现在是**「本地编排 Agent」面板底部的一个折叠区**（点标题那一行展开），因为它是给那个 Agent 用的、
日常并不需要动。展开后可以：

`mesh agent` 需要一个 OpenAI 兼容端点来做判断（见 §4.7.1）。面板里可以：

* 填 **API 地址**（以 `/v1` 结尾）与**模型**；
* 点「拉取模型列表」——从网关的 `/models` 取回可用模型，填进输入框的候选列表；
* 填 **API 密钥**，或填**密钥所在的环境变量名**（推荐，见 §7.4）；
* 点「清除内存中的密钥」；
* 勾选**是否记住地址和模型**（默认记住）。

#### 正确顺序：拉列表**不需要**先保存

| 步骤 | 做什么 |
|---|---|
| 1 | 填 **API 地址**（例如 `http://10.0.0.5:8000/v1`） |
| 2 | 填 **API 密钥**（或填密钥所在的**环境变量名**） |
| 3 | 点「**拉取模型列表**」——它用的是你**刚填进去的值**，与是否保存无关 |
| 4 | 从「模型」框的下拉里选一个（或直接输入名字） |
| 5 | 点「**保存并测试连接**」 |

> 第 3 步以前**要求你先点保存**，因为那个按钮只发一个裸 `GET /api/agent/models`，只能看见
> 已经存下来的配置。而"想知道有哪些模型"正是**在你不知道模型名之前**做的事，于是自然顺序
> 恰好被反过来了（这是缺陷 54）。那时的报错是
> `LLM not configured: set AGENTMESH_LLM_BASE_URL or pass --base-url.`——
> 这句话本身没错，但它在讲一个**你在浏览器里从没碰过的环境变量**，
> 于是你会去查环境变量、重启服务、怀疑网关，而真正缺的只是"先按一下保存"。现在按钮改用
> `POST` 把当前表单值带上去，**只用于这一次查询**：不落盘、不改动运行中的配置，
> 所以"只是看看有哪些模型"不会变成一次配置变更。

> **空的框 = 不改动**（地址、模型、密钥、环境变量名，四个框都是）。
> 表单每次保存都会把所有框发一遍，所以"空"必须表示"别动它"：早先只有密钥框是这个约定，
> 模型框空着会把**空字符串**提交上去，于是"只想补一个密钥"会顺手把模型抹掉，
> agent 立刻变成 `ready:false, missing:["model"]` 再也跑不了，而那个框**看起来什么都没被动过**
> （这是缺陷 55）。**清空**只存在于那个有专门按钮的字段上（「清除内存中的密钥」）。

> **一个刻意的行为**：在这里**只填密钥**，**不会**把已经保存的地址和模型抹掉。
> 早先不是这样——`llmConfig()` 一旦发现存在运行时覆盖就**整体返回那个覆盖对象**，
> 于是"填个密钥"会顺手清空地址和模型，界面立刻变成"未配置"，而你会去怀疑网关或密钥本身。
> 现在是把补丁**叠加**在当前生效的配置之上（缺陷 40），并且空框一律不参与提交（缺陷 55）。
>
> 另注：缺陷 40 只影响**控制面**。CLI 走的是 `AGENTMESH_LLM_*` 环境变量 + 配置文件回退，
> 不经过那条覆盖路径，所以命令行一直是对的。

### 7.4 密钥策略：只进内存，或者进一个你自己选的文件

这条值得单独讲清楚，因为它是"**能改权限**"与"**别把密码写进文件**"之间最容易做错的地方。

| 机密 | 存在哪 | 落盘吗 | 重启 `mesh serve` 后 |
|---|---|---|---|
| SSH 密码（界面或运行时给的） | **服务进程内存** | ❌ 不落盘 | **需要重填** |
| SSH 密码（`--ssh-password-env NAME`） | 环境变量 `$NAME`；注册表里只存**名字** | ❌ 不落盘 | ✅ 仍可用 |
| SSH 密码（`mesh secrets set NAME`） | `~/.agentmesh/secrets.env`；注册表里只存**名字** | ✅ **落盘，权限 0600，明文** | ✅ 仍可用 |
| SSH 密钥文件（`--ssh-key`） | 你自己的文件 | 只有**路径**进注册表 | ✅ 仍可用 |
| LLM API 密钥（界面给的） | **服务进程内存** | ❌ 不落盘 | **需要重填** |
| LLM 密钥（`apiKeyEnv` / `--api-key-env NAME`） | 环境变量 `$NAME`；文件里只存**名字** | ❌ 不落盘 | ✅ 仍可用 |
| LLM 地址与模型 | `.agentmesh/llm.json` | ✅ 落盘（本来就不是机密） | ✅ 仍可用 |
| A2A / opencode 的 token | `nodes.json` | ✅ 落盘 | ✅ 仍可用 |
| **控制台登录口令** | `~/.agentmesh/console-users.json`（`mesh auth`） | ✅ 落盘，**scrypt 哈希**（0600）——**不可还原** | ✅ 仍可用（会话本身不跨重启，见 §7.8） |

一句话：**怕重启后要重填，就存"变量名"而不是"值"。** 存名字的路径在任何时候都不会把机密写进磁盘。

#### 让密码跨重启保留：`mesh secrets`

存名字解决了"注册表里不写密码"，但**变量本身**仍然得有人设。以前的办法是自己去设环境变量（改 shell 配置、写服务文件），在 Windows 上还要重启终端；`mesh secrets` 就是把这个动作收进程序里：

```bash
mesh secrets set NAS_SSH_PW          # 交互式输入，不回显
mesh secrets set NAS_SSH_PW --stdin  # 从管道读，便于脚本
mesh secrets list                    # 只看名字，永不显示值
mesh secrets rm NAS_SSH_PW
mesh secrets path                    # 文件在哪
```

然后在节点里照旧填**变量名**（界面「或：密码所在的环境变量名」那一栏，或 `--ssh-password-env NAS_SSH_PW`）。启动时 `bin/mesh.js` 会先读这个文件，所以**重启之后不用再输密码**。

`mesh secrets list` 会区分两种状态：

```
NAS_SSH_PW   in effect                  # 生效中：来自这个文件
NAS_SSH_PW   shadowed by the environment # 被真实的环境变量盖住了（真实环境优先）
```

**必须说清楚的三件事**：

1. **它在磁盘上是明文。** 保护来自**文件权限**（`0600`，只有你自己能读）而**不是加密**。Windows 上 `mode` 不是权限模型，保护来自你用户目录的 ACL。这和 `~/.netrc`、`~/.pgpass`、`~/.aws/credentials` 是同一个形状——**它们是明文，也没打算变成密文**。
2. **更优解仍然是 SSH 密钥。** 这次做 `secrets` 是因为"每次重启重打密码"的实际后果是**人会开始挑一个更短的密码**——一个为了安全而拒绝落盘的设计，最后把人推向更弱的口令。但如果你愿意折腾密钥，那条路严格更好，建议优先。
3. **不做"加密存储"**：那需要一把同样要存在某处的钥匙，问题只是被挪了一层。而这个项目的原则是**凭据留在需要它的那一侧**，控制面只持有"访问节点所需的东西"。

真实环境变量**总是优先**（与 Node 的 `--env-file` 一致），所以临时用 `$env:NAS_SSH_PW='...'` 覆盖一次文件里的值是好用的。写入时会拒绝含**换行**的值（那会追加出第二个赋值）和同时含**两种引号**的值（无法无歧义地引用）——**一个被悄悄改掉的密码是没人能调试的那种故障**，所以宁可拒绝。

界面上的密码框会明确写着"只存在服务进程内存里，不写进任何文件"，以及**要怎么让它不用重填**——不让用户以为它被保存了，也不让用户以为只能每次重打。

### 7.5 对话面板显示什么：过程折叠与两个开关

本机编排 Agent 干一件真事时会产生一串过程事件——思考、工具调用、工具结果、派发。这些东西在**排查时是你最想看的**，在**平时是最吵的**。所以默认是这样的：

```
你  检查一下 NAS 的磁盘，不够的话清理一下日志
▸ 过程 · 思考 8 · 调用 3 · 结果 3 · 派发 1        ← 折起来了，点一下展开
答复  磁盘还剩 40%，/vol1 占用最大的目录是 …
```

- **答复始终显示**，而且**不在折叠块里**；
- 每一轮一个折叠块，**默认收起**；
- 摘要行上的数字**始终统计，包括被你关掉的类型**——把细节藏起来可以，把"它做过事"一起藏掉不行。一轮什么都没做的运行和一轮被藏起来的运行，在排查时是完全不同的两件事，摘要就是你区分它们的地方。

两个开关在对话面板下面：

| 开关 | 默认 | 打开后 |
|---|---|---|
| 思考过程 | **关** | 折叠块里显示模型的思考 |
| 工具调用与派发 | **关** | 折叠块里显示工具调用、结果、派发 |

设置存在**浏览器**（`localStorage` 的 `agentmesh.display`）而不是服务端：这是"你习惯怎么读这个面板"，不是这个集群的属性，不该跟着配置跑到另一个浏览器里。

### 7.6 跨节点共享上下文：默认隔离

**默认情况下，一个节点完全不知道另一个节点的存在。** 你给 `nas主机` 发的命令和它的回复，`阿里云` 一个字都看不到——会话在程序里是按节点分键的（`lastSession(nodeId)`、`historyForContext({nodeId, contextId})`），这是刻意的默认值：一次跨越两个 Agent 的意外泄漏是**静默**的，而静默的泄漏是这里最坏的一类故障。

但多智能体协作同一件事时，让它们互相知情会快很多。所以这是一个**开关**，四个入口，**默认全关**：

| 入口 | 怎么开 |
|---|---|
| 命令行单发 | `mesh send nas "…" --share-context`（`--share-limit 6` 控制条数，默认 6） |
| Web 发任务面板 | 勾「带上其他节点的最近往来」 |
| 本机编排 Agent | 勾「跨节点共享上下文」（它派出去的每个任务都会带上） |
| 编排器扇出 | 同上，跟着运行级策略走 |

打开之后，对端收到的文本开头会多一段**有明确起止围栏**的东西：

```
[Shared context from AgentMesh — recent work by OTHER agents, not your own conversation]

nas主机 was asked: 列出 /vol1 下的目录
nas主机 answered: /srv/work、/opt/hermes/data …

[End of shared context. Your own task follows.]

检查一下磁盘
```

几个刻意的设计：

- **围栏和那句"不是你自己的对话历史"是必须的。** 一段读起来像自己过往轮次的文字，最坏的结果是模型以为**自己已经答过**，于是跳过工作。
- **真实请求排在最后。** 对端先读到的是任务，不是别人的历史。
- **只包含"其他"节点**，不含目标节点自己（它自己的上下文另有通道，见 4.3 的 `--continue` / `--with-history`）。
- **只包含有答案的轮次。** 一个没人回答过的问题注入进去，读起来像"它没做这件事"。
- **会截断**（提问 400 字符、答复 800 字符）。一条大结果足以把真正的请求挤出上下文。
- **落库的任务记录仍然是你原话。** `mesh task <id>` 读回来不该是一屏别人的历史——注入发生在发出的路上，不是记录里。

**和 `--with-history` 的区别**（这两个容易混）：`--with-history` 回放的是**同一个节点、同一个上下文**里你自己的前几轮，用来对付"接受 `contextId` 但每次只按最新消息回答"的对端；`--share-context` 拿的是**别的节点**最近的轮次。可以同时用，也可以都不用。

### 7.7 HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 控制台页面（需登录） |
| GET | `/login` | 登录页（公开） |
| POST | `/api/login` | `{user, password}` → 设置会话 cookie（公开） |
| POST | `/api/logout` | 结束会话，并掐断该会话的实时流（公开、幂等） |
| GET | `/api/session` | `{authenticated, authRequired, user, expiresAt}`（公开） |
| GET | `/healthz` | `{ok, nodes, bootId, startedAt, pid}`；未登录时只报 `{ok, bootId, startedAt}` |
| GET | `/api/status` | 注册表/库路径 + 统计 |
| GET | `/api/presets` | 内置预设 |
| GET | `/api/nodes` | 节点列表（敏感字段已脱敏） |
| POST | `/api/nodes` | 注册节点（接受完整配置对象，含 CLI 没有的字段） |
| POST | `/api/nodes/:name/update` | **改字段**（与 `mesh node edit` 同一路径；只改给定字段，并立即失效缓存适配器） |
| POST | `/api/nodes/:name/secret` | `{sshPassword}` —— 设置/清除**只活在本进程内存里**的 SSH 密码 || POST | `/api/nodes/:name/probe` | 探测 |
| POST | `/api/nodes/:name/delete` | 删除 |
| GET | `/api/tasks?node=&limit=` | 任务列表 |
| GET | `/api/tasks/:id?events=1` | 单任务（可选带事件） |
| GET | `/api/events?after=<seq>` | 事件增量（HTTP 拉取） |
| GET | `/api/stream?after=<seq>` | **SSE 实时流**（先回放 `after` 之后的事件） |
| POST | `/api/send` | `{node, prompt, continue?, cwd?, approval?}` → `202 {taskId}` |
| POST | `/api/cancel` | `{taskId}` |
| GET | `/api/approvals?status=pending\|all` | 审批列表（带 `live` 标记：是否还有活动连接持有） |
| POST | `/api/approvals/:id` | `{optionId}` 作答（`optionId: null` = 拒绝） |
| POST | `/api/agent` | `{prompt, dryRun?, tools?, maxSteps?}` → `202` —— 本地编排 Agent（§4.7） |
| GET | `/api/agent/config` | 编排 Agent 的生效配置（密钥只报长度，从不回显内容） |
| POST | `/api/agent/config` | `{baseUrl?, model?, apiKey?, apiKeyEnv?, persist?}` —— 地址/模型可落盘，密钥只进内存 |
| GET | `/api/agent/models` | 从配置的网关拉取模型列表 |

`/api/send` 是**即发即返回**（`202`），进度从 `/api/stream` 取。

**除了上表里标了"公开"的四条，其余每一条都需要会话 cookie**——包括 `/api/stream`。鉴权在**路由匹配之前**
执行，不是逐条路由加的：逐条加的闸门，下一个新增路由一定会漏掉，而漏掉的那个通常正是泄漏最多的那个。

表里的 `:name` 处也接受**节点 id**（服务端按 `:ref` 解析：先当名字找，再当 id 找），
所以脚本里用名字还是用 id 都可以。

`POST /api/nodes/:ref/update` 与 `mesh node edit` 走的是**同一个** `registry.update()`，
两者都只改你传的字段，并且都会**让适配器缓存失效**——否则长驻的控制面会继续用旧配置，
表现为"改了没生效"。

三个接口**永远不回显机密**：`GET /api/nodes` 里没有密码，`GET /api/agent/config` 里的密钥只报
`set:<长度>`。这是刻意的：一个会回显机密的读接口，等于把"改配置"的权限悄悄升级成"读机密"的权限。

### 7.8 登录、账号，以及"能不能从别的机器访问"

**先理解这个控制台有多危险**：它能向**每一个已注册的智能体**派发任务、能**批准**它们提出的操作
（包括危险命令）、能改写节点注册表。绑在 `127.0.0.1` 上时这不是问题——本机上你就是那道边界，
那是操作系统该管的事。但一旦它能被别的机器访问，**没有登录的控制台比没有控制台更糟**。

#### 规则：账号是可选的（仅回环），不是可关闭的

| 情况 | 行为 |
|---|---|
| **有账号** | 一律要登录，**包括绑 127.0.0.1 时**。"建了第一个账号"就是"锁上"这个动作 |
| 没账号 + 绑回环 | 维持原样，不需要登录 |
| **没账号 + 绑任何非回环地址** | **拒绝启动**，并告诉你先跑 `mesh auth add` |

最后一行是这个功能存在的原因：**"暴露且敞开"不能是加一个 flag 就能到达的状态。** 没有
`--no-auth`，也没有"没账号就跳过"的分支——一个能关掉它的开关，迟早会出现在某个自启动配置里。

账号文件**读不出来时会拒绝启动**（而不是当作"没有账号"放行），认证**失败一律当作不认识**
（fail closed）。方向永远偏向"进不去"，因为偏向另一边的失败是不可见的。

#### 会话

- 登录后发一个 `HttpOnly` + `SameSite=Lax` 的会话 cookie，**默认 12 小时**，使用中自动续期。
- **会话存在服务端内存里**，所以"登出"是真的登出（不是把一个还能用的签名 token 从浏览器删掉），
  而且**重启控制台会登出所有人**。
- **登出会同时掐断那条实时流。** SSE 连接的生命周期长于打开它的那个请求，不显式关闭的话，
  一个已经登出的浏览器会继续收到每一个任务、审批和 agent 思考——正好和按钮承诺的相反。
- **改密码会让旧会话立刻失效。** `mesh auth passwd` 跑在**另一个进程**里，所以两者之间唯一的
  通道是那个文件；判据是"会话当初是拿哪个哈希签发的"，与当前哈希比对——**不用时间戳**，
  因为两次改密码会产生长度完全相同的文件、也可能落在同一毫秒里，那种比较会漏掉。
- **失败限流**：同一账号或同一来源地址 5 次失败锁 5 分钟。代价说明白：知道账号名的人可以故意
  失败几次把那个账号锁住。这是有意接受的——只按地址限流挡不住分布式猜测，而等待成本很低。
- **CSRF**：所有改状态的请求必须是 `application/json`，且 `Origin` 与 `Host` 不符就拒绝。
  跨站的 `<form>` 发不出 JSON，这就是它成为防线的原因（`SameSite=Lax` 是第一道）。

#### 从别的机器访问：口令是明文过网的

这是必须说清楚的一点。**这个控制台说的是明文 HTTP，没有 TLS。** 所以：

> 登录挡得住"随手点进来的人"，**挡不住同一网络里能抓包的人**——密码和会话 cookie 都是明文过网。

真正安全的两条路，按推荐顺序：

**① SSH 隧道**（不需要在对端装任何东西，也不改配置）：

```bash
# 在你自己的电脑上跑；把 7331 映射到服务器上的 127.0.0.1:7331
ssh -L 7331:127.0.0.1:7331 yanyu@192.168.10.22
# 然后浏览器打开 http://127.0.0.1:7331 —— 走的是加密隧道
```

这样服务端**只绑回环**，网络上根本没有暴露的端口。

**② TLS 反向代理**（要在局域网上给别的设备/手机用时）：让 nginx/caddy 终止 TLS，反代到
`127.0.0.1:7331`，并**务必**传 `X-Forwarded-Proto: https`——控制台据此把会话 cookie 标成
`Secure`（不标的话浏览器会在 HTTPS 页面上丢弃它，表现为"登录成功了但每个请求都是匿名的"）。
同时把 `X-Forwarded-For` 传上，否则限流会把所有请求算成同一个来源：

```nginx
location / {
  proxy_pass http://127.0.0.1:7331;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;   # 让会话 cookie 变成 Secure
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;  # 让限流分得清来源
  proxy_buffering off;                          # SSE 实时流必须关缓冲，否则事件会攒着不发
}
```

**直连绑定**（`mesh serve --host 0.0.0.0`）仍然支持，但它会打印一段警告，因为 URL 看不出这件事。
真要用，至少要：设了账号、只在可信网段、并且清楚上面那条明文限制。

#### 认证**没有**保护的东西

- **`GET /healthz` 是公开的**（监控不该需要凭据），但未登录时只报 `{ok, bootId, startedAt}`——
  节点数量和 pid 不是健康检查该知道的。
- **不在 TLS 后面就没有传输加密**（见上）。
- **它不区分权限。** 每个账号都是完全权限（能派任务、能批准、能改注册表）。多账号目前是为了
  "区分是谁"和"能单独吊销"，不是分权。这是当前实现的边界，不是缺陷。
- **不做审计**。谁在什么时候批准了什么，库里只有审批记录本身。

---

## 8. 状态、配置与环境变量

### 状态目录

默认 `~/.agentmesh/`，用 `AGENTMESH_HOME` 覆盖（例：`AGENTMESH_HOME=D:\工作\.agentmesh`）：

| 文件 | 内容 | 能否手改 |
|---|---|---|
| `nodes.json` | 节点注册表 | ✅ 可以直接编辑 |
| `mesh.db` | SQLite：`tasks` / `events` / `approvals` | ⚠️ 只读查看，别手改 |

```bash
mesh status            # 一眼看到：状态目录、节点数、任务数、待审批、事件总数
```

### 环境变量

| 变量 | 作用 |
|---|---|
| `AGENTMESH_HOME` | 状态目录（默认 `~/.agentmesh`） |
| `AGENTMESH_SSH` | 指定 ssh 可执行文件 |
| `AGENTMESH_DEBUG` | 报错时附带堆栈 |
| `MESH_ASKPASS_SECRET` / `MESH_ASKPASS_SECRET_FILE` | 密码型主机的密码（§5.3） |
| `NO_COLOR` / `FORCE_COLOR` | 关/开彩色输出 |

---

## 9. 故障排查

以下都是**实际踩到过的**错误消息与成因：

| 现象 | 原因 | 处理 |
|---|---|---|
| `spawn EPERM` | 运行环境的沙箱禁止管道的 stdio。**ACP 的稳定传输就是 stdio**，绕不过去 | 换到允许子进程的环境运行；这是环境限制，不是配置错误 |
| **`mesh probe` 说"连不上"** | 三种完全不同的原因，**必须分开**：① `ECONNREFUSED` = 包到了主机、主机回 RST，**没人监听**（或只绑了 `127.0.0.1`）；② `UND_ERR_CONNECT_TIMEOUT`/`ETIMEDOUT` = **收不到任何回应，中间有东西在丢包**（云安全组 / `iptables -j DROP`）；③ `ENOTFOUND` = DNS 没解析 | 先跑 `node tools/verify-a2a.mjs --url <你的地址> --token <secret>` 拿到明确结论；②去云安全组放行入站 TCP，并确认进程绑的是 `0.0.0.0` 而非 `127.0.0.1`；见 §5.4 |
| `mesh probe` 成功但 `mesh send` 超时，且错误里的地址**不是你填的地址** | 对端 Agent Card 里宣告的是它自己的**内网地址**（NAT/VPC 后常见）。客户端已自动回退到可取到卡片的通路并打 `!` 告警 | 看告警即可；根治办法是在对端设置它的对外 URL。若你确实需要手动指定，`mesh node add` 时填对端可外部访问的那个地址 |
| `rejected the task: Method not found: SendMessage` | 对端只实现了 v0.3 的 `message/send`（老版本或简化实现） | 客户端会**自动换名重试**，通常不必干预；若仍失败，说明对端连 `message/send` 也不认，用 `mesh probe` 看它的 `interface` 与 skills 再核对文档 |
| **多轮对话"失忆"**：第二轮不记得第一轮，或它自己说"未收到此前轮次" | 对端接受 `contextId` 但不据此重建会话（缺陷 28）。`--continue` 本身只复用 id，**默认不带历史** | 加 `--with-history`。用 §5.4 的记忆测试确认；对 ACP/opencode 节点不需要它 |
| `error: remote acp/cli node requires --ssh <host>` | 注册时既没给 `--local` 也没给 `--ssh` | 二选一补上 |
| `error: transport acp over ssh requires --command` | 远端没有可通过 `PATH` 找到的预设命令 | 用 `--command /full/path/to/agent` 明确指定 |
| 远端命令 exit **127** | 远端找不到可执行文件，或路径引号不对 | `mesh probe` 先确认能起来；用绝对路径 |
| ssh 卡在密码提示 / 任务无输出 | 该主机只接受密码，但你用了默认的 `BatchMode=yes` | 按 §5.3 配 askpass 并加 `--ssh-batch-mode no` |
| 审批弹出来了，但 `mesh approve` 说"没有活动连接持有它" | 你派发任务的那个进程已经退出，或不是同一个 `--port` | 让 `mesh serve` 常驻并由它派发；确认 `--port` 一致 |
| `mesh cancel` 报"no live connection holds it" | **这是正确行为**：没有进程持有该任务，取消无法送达，记录因此**故意不改** | 让 `mesh serve` 常驻（由它发任务），或用 Web 控制台取消 |
| 任务永远停在 `working` | 控制面进程被杀了（例如审批期间） | 下一次任何命令会自动对账，把孤儿任务标为 `failed(interrupted)` |
| `mesh watch` 里什么都看不到 | 见 §4.5：它只订阅自己进程的事件 | 改用 `--task <id> --follow` 回放，或看 Web 控制台实时流 |
| `--node` 后面的值丢了 / 报"requires a value" | 值以 `-` 开头，被当成 flag 了 | 用 `--flag=--value` 形式 |
| `mesh serve` 好像"改了代码却没生效" | 端口上跑的是**上一轮的旧进程** | 用 `/healthz` 里的 **`bootId`/`pid`** 核对；先杀干净再起 |
| Windows 上把 `AGENTMESH_SSH` 指向 `.cmd`/`.bat` | Node 直接执行会 `EINVAL`；加 `shell:true` 又会被 cmd.exe 重新切分 argv，**静默破坏每一条远端命令** | 明确拒绝这种 binary。改用 `--ssh-binary <node.exe> --ssh-binary-arg <包装脚本>`（§5.3 就是这个套路） |

---

## 10. 开发进度

对照 [`PLAN.md`](PLAN.md) 第 5 节的里程碑：

| 阶段 | 内容 | 状态 | 依据 |
|---|---|---|---|
| **M0** | 调研 + 协议 schema 固化 | ✅ 完成 | 本地语料 `research/landscape.md`、`research/schemas/`（含 ACP v1 `schema.json`、opencode v1.18.31 OpenAPI）——已 gitignore，用 `tools/fetch.mjs` 重新抓取 |
| **M1** | 协议层（states/jsonrpc/acp/a2a） | ✅ 完成 | `test/protocol.test.js` 29/29 |
| **M2** | ACP 适配器 + 注册表 + Store + `send` | ✅ 完成 | **本机真实 Hermes 0.21.3 跑通问答**（ACCEPTANCE 3.1/3.2） |
| **M3** | A2A 适配器 | ✅ **完成** | 对着**真实第三方公网对端**（云上 Hermes v0.14 A2A 桥，背后真实 LLM）端到端跑通 **live 10/10**，并完成一次**真正的多轮对话**（含记忆测试）+ 由对端把会话落盘到它自己的服务器；内置真实 A2A v1.0 服务端覆盖流式与 v1.0 方法名 **23/23**。过程中依次修掉四个真实互操作缺陷：网络失败无法归因、卡片宣告内网地址、v0.3/v1.0 方法名差异、`--continue` 不夹带历史导致"假对话"（ACCEPTANCE 3.7） |
| **M4** | 扇出/竞速/聚合 + 历史 + 审批资源 | ✅ 功能完成，2 处保留 | 审批闭环真机 15/15、真机 NAS 挂起+人工裁决；扇出选择单测 5/5。**`--mode best` 未实现（= `all`）**；**没有两个真实节点同时跑过** |
| **M5** | opencode 适配器 + SSH 传输 | ⚠️ 一半 | **SSH 全部完成且真机验证**（局域网 NAS **35/35**：真实 sshd、真实密码认证、真实远端 Linux + Hermes）；**opencode 只有 mock**（本机没装 opencode） |
| **M6** | Web 控制台 | ✅ 完成 | `src/web/server.js` + `ui.html`；审批闭环**全程只走 HTTP API** 驱动 15/15；顶部新增本地编排 Agent 对话面板（`POST /api/agent`，与 CLI 复用同一个 `runAgent()`）；**注册表单按传输方式自适应（主机/用户名/端口/命令全路径/认证方式）、节点可编辑、新增「编排 Agent 的模型」面板、节点行直接标出配置隐患**（ACCEPTANCE 3.9，缺陷 36–40/44） |
| **M7** | 本地编排 Agent（一句话 → 自己派活） | ✅ 完成 | 对着**真实局域网 OpenAI 兼容网关 + 真实远端 agent** 跑通：自己查节点清单、让 NAS agent 写函数并原样带回、走 A2A 拿回对端原话、失败时如实报告且不编造。确定性验收 `verify-agent.mjs` **28/28**（ACCEPTANCE 3.8） |
| **M8** | 文档、安装脚本、端到端验收 | ✅ 基本完成 | `README` / `PLAN` / `ACCEPTANCE` / `USAGE`；零依赖故不需要安装脚本；8 个验证脚本 + 2 个自检脚本（含"检查器自己的自测"） |

**一句话总结**：核心闭环（注册 → 探测 → 派发 → 流式 → 审批 → 落库 → 控制台）已经**完成并在真机验证**，
**"在本机对一个 Agent 说一句话，由它自己决定派给哪台机器"也已跑通**；剩下的缺口是"**缺一个真实对端**"，
不是"没实现"：第三方 A2A 实现、真实 opencode server。

**当前测试规模**：`npm test` **240 个用例 / 19 个文件**（232 通过 + 8 个需要真子进程的用例在受限沙箱内
诚实跳过并说明原因——提权后 8/8 全部通过）。

**验证脚本**（都保留在仓库里可复跑）：

| 脚本 | 检查数 | 验证对象 |
|---|---|---|
| `node tools/verify-approval.mjs` | 15 | 真实 Hermes，全程只走 Web API |
| `node tools/verify-ssh-acp.mjs` | 13 | ACP over SSH 路径（传输层由 `fake-ssh.mjs` 顶替） |
| `node tools/verify-a2a.mjs` | 23 | **内置真实 A2A v1.0 服务端**（真 HTTP/JSON-RPC/SSE/鉴权、流式 `append` 语义） |
| `node tools/verify-a2a.mjs --url … --token …` | 10 | **真实第三方公网对端**：连通性 + 卡片 + 派发 + 取回响应 |
| `node tools/verify-lan.mjs` | 35 | **真实局域网主机**：真实 sshd + 真实远端 Hermes，产物独立回读核对 |
| `node tools/verify-agent.mjs` | 28 | **本地编排 Agent**：脚本化 LLM + 真实 A2A 对端，覆盖路由/扇出/纠错/失败/权限闸门/步数上限 |
| `node tools/verify-console.mjs` | 21 | **真控制面 + 真 NAS**：按浏览器那套 HTTP 调用注册/探测/编辑/删除，含"错误必须解释自己"（需真 ssh，沙箱内 2 项会失败） |
| `node tools/check-ui.mjs` | 4 类规则 | 控制台界面静态自检：脚本可编译、`$('id')` 有对应元素、`data-*` 有产出、禁止用 DOM 位置切布局 |
| `node tools/check-ui.selftest.mjs` | 7 | **检查器自己的自测**：注入 5 种缺陷，断言检查器必须报错；再加一条反向断言——注释里描述缺陷**不得**被当成缺陷（缺陷 48）。抓不到问题的 lint 等于没有 lint |
| `node tools/check-docs.mjs` | 12 项 | **文档自检**：跨文档计数一致、缺陷表连续、相对链接可解析、章节编号连续 |
| `node test/acp-lifecycle.test.js` | 3 | 真实子进程下的连接生命周期 |
| `node test/cli-cancel.test.js` | 5 | 真实子进程 + 桩 daemon：`mesh cancel` 不得谎报 |

**开发过程中被抓出并修复的真实缺陷：66 个**，及各自的触发条件，全部记在
[`ACCEPTANCE.md`](ACCEPTANCE.md) 第 4 节。其中最严重的几条是"会让核心特性在生产中静默失效"的：
审批全部被当成拒绝、审批永久阻塞、任务结果恒为空、按能力扇出选中 0 个节点、消费方永远等不到结束事件、
**控制台对刚探测过的节点永远发不出任务**、**取消任务会谎报成功而 agent 其实还在干活**、
**所有网络失败都显示成同一句 `fetch failed`，让人无法区分"没人监听"和"防火墙丢包"**、
**盲从卡片里的内网地址、把配置错误伪装成防火墙问题**、以及**只用 v1.0 话术、导致一个完全能用的对端被判为失败**。
后一批（36–50）则集中在**控制面**与**验证工具**，而且大多有一共性——**它们只在浏览器里、或只在偶发时才会暴露**：
**界面按设计就注册不出可用的 SSH 节点**、**密码既明文落盘又毫无用处**、**填个密钥反而把已配好的地址和模型抹掉**、
**隐藏一个字段会把整个表单隐藏掉**（44）、**只改一个端口会把节点的产品标签改掉**（47）、
**检查器会在注释里把"规则的说明文字"当成违规代码**（48）、
**测试用的假服务器被 OS 分到 fetch 按规范拒绝连接的端口、于是随机挂**（46）、
**送密码进 ssh 子进程的唯一通道和"本该只读"的 `runtimeNode()` 都没有测试**（49）、
以及**用 `--ssh-password-env` 建的节点永远用不上那份密码，因为命令行没像界面那样关掉 `BatchMode`**（50）。
46 特别值得一提：它失败的测试与被测代码毫无关系，而**偶发比硬失败更危险**——它会训练所有人
"重跑一遍、忽略红色"。50 则是"**同一件事在界面里能做、在命令行里不能**"的样本——
**"文档与实现一致"不等于"两条入口彼此一致"**。

> 最后那条（第 23 条）是**写这份文档时抓出来的**：为了把 `mesh cancel` 的用法写准确，去读它的实现，
> 才发现它在没有活动连接时会打印 `✓ canceled` 并退出 0，而 agent 根本没被叫停。
> 给一个行为写文档，本身就是一种验证。

---

## 11. 已知限制

逐项状态以 [`ACCEPTANCE.md`](ACCEPTANCE.md) 第 5 节为准。要点：

- **SSH 传输**：已在真实主机上跑通（真实 sshd / 密码认证 / host key 校验 / 远端 Linux）。
  未验证：**密钥认证**（那台 NAS 没有家目录，需 `sudo` 建，属对用户系统的持久改动）、
  `ProxyJump` 跳板机、**网络中断与超时的恢复行为**。
- **opencode 适配器**：只对逐字节复刻其线格式的 mock 验证过。
- **A2A 通道**：已对着**真实的第三方公网实现**（云上 Hermes v0.14 A2A 桥）端到端跑通
  （`verify-a2a.mjs --url …` → 10/10），客户端这一侧另有内置真实 v1.0 服务端覆盖（23/23）。
  该端点暴露过两个真实互操作坑，都已吸收：卡片宣告**内网 RPC 地址**（客户端会改用可取到卡片的
  那条通路并告警，见 §9 与 ACCEPTANCE 3.7.2）、以及只实现 **v0.3 方法名** `message/send`
  （客户端按卡片版本选名，并在 `-32601` 时自动换名重试）。
  该对端接上真实模型后，又用它跑通了**一次真正的多轮对话**（`--with-history` + 记忆测试，
  ACCEPTANCE 3.7.3），并让对端把会话落盘到它自己的服务器。
  未验证：真实 `input-required` 往返、`pushNotifications` 回调（对端 `push=false`），
  以及对端落盘文件的**独立核验**——该云主机只有 A2A 可达、没有 SSH 凭据，目前只有对端自述。
- **A2A 的会话连续性依赖对端**：`contextId` 只是分组标签，对端不一定据此重建会话，
  于是"多轮对话"可能每轮都是孤立的**而客户端看不出区别**（缺陷 28）。
  用 `--with-history` 由客户端补上历史，并用记忆测试确认（见 §4 对 `--continue` 的说明）。
- **`fs/*` / `terminal/*` 客户端能力**：**默认不宣告**（设计选择）。`fs/*` 有实现但从未被真实 agent 触发。
- **`mesh broadcast --mode best`**：等同于 `all`，择优未实现；`first` 也不是严格竞速。
- **多节点扇出**：只跑过单个真实远端节点。
- **`cli` 传输**：没有审批通道。
- **跨进程限制（设计如此，不是 bug）**：
  - `mesh cancel` 只能经活动连接送达 —— 没有进程持有任务时会**明确报错且不改记录**（§4.5）；
  - `mesh watch` 只订阅本进程的事件（§4.5）；想要跨进程实时流用 `mesh serve` + `/api/stream`；
  - 审批不受影响，它落库且可寻址。
- **跨平台**：控制面**只在 Windows 上实测**过（被控端有真实 Linux）。
- **长时稳定性**：未做长时间 / 高并发压测。

---

## 12. 最短路径速查

```bash
# 接一个本机 Hermes
mesh node add h --kind hermes --local --cwd /path/to/project
mesh probe h && mesh send h "hello"

# 接一个远端 Hermes（免开端口）
mesh node add hb --kind hermes --ssh 10.0.0.5 --ssh-user root --cwd /srv/work

# 接一个远端 Hermes 的 A2A（对端需监听 0.0.0.0 且安全组放行该端口）
mesh node add hb2 --transport a2a --url http://10.0.0.5:9900 --token <secret>
node tools/verify-a2a.mjs --url http://10.0.0.5:9900 --token <secret>   # 连不上时先跑这个

# 要人批准才能动手
mesh serve --port 7331 &
mesh send hb "写入报告" --approval ask
mesh approvals && mesh approve appr_xxxx --allow

# 扇出
mesh broadcast "报告状态" --capability '*'

# 看历史
mesh tasks && mesh task <id> --events
```
