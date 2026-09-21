# AgentMesh 验收报告

本文件只记录**实际跑过的东西**和**实际看到的输出**。没有跑过的部分单列在
[未验证项](#未验证项)，不做推断性表述。

> **关于本文中引用的 `logs/*.txt` 转录：** 它们是验证脚本在本机跑出来的产物，含真实主机信息，
> 因此**不随仓库分发**（`logs/` 已在 `.gitignore` 中）。要看某一份，照本文给出的命令重跑一次即可——
> 例如 `node tools/verify-lan.mjs --log logs/lan-acceptance.txt`。文中的通过数/失败数是可以独立复核的断言，
> 转录只是它们的原始出处。

验证环境：

| 项 | 值 |
|---|---|
| 控制面主机 | Windows，工作目录 `D:\工作` |
| Node | **v22.23.2**（`node --version` 实测；PATH 中的 node 是 Hermes 自带的 `%LOCALAPPDATA%\hermes\node\node.exe`） |
| 依赖 | 零 npm 依赖（`node:sqlite`、`node:test`、全局 `fetch`，无 `node_modules`） |
| 被测智能体 | Hermes `0.21.3 (2026.9.14)`，安装方式 git，Python 3.11.16 |
| Hermes 二进制 | `%LOCALAPPDATA%\hermes\bin\hermes-acp.exe` |
| **真实远端节点** | 局域网 NAS `10.0.0.5`（Debian 12），`sshd` 端口 **2222**，账号 `user`，**只接受密码认证**（无 `~/.ssh`，`/home/user` 不存在） |
| **远端智能体** | 应用商店版 Hermes `0.18.0`，运行时 `/opt/hermes/bin/hermes-acp` |
| 控制面出口 IP | **10.0.0.9**（到达 NAS 的实际路由源地址） |
| 状态目录 | `AGENTMESH_HOME=D:\工作\.agentmesh` |
| 本机是否安装 opencode | **否**（因此 opencode 走的是协议级 mock 验证，见下） |

---

## 1. 复现方式

```powershell
# 单元 + 集成测试（18 个文件，217 个用例）
# 逐个跑是受限沙箱下的等价方式：`node --test` 的 runner 模式要为每个文件 spawn 子进程，
# 而沙箱会拒绝带管道的 spawn。逐个执行在进程内跑，结果完全一致。
node --test test/                 # 或在受限环境下逐个跑：
node test/protocol.test.js
node test/args.test.js
node test/a2a-adapter.test.js
node test/opencode-adapter.test.js
node test/http.test.js
node test/llm.test.js
node test/orchestrator.test.js
node test/acp-lifecycle.test.js
node test/cli-cancel.test.js
node test/approval.test.js
node test/fleet.test.js
node test/store.test.js
node test/ssh.test.js
node test/web.test.js
node test/net.test.js

# 真实端到端：CLI 探测 + 发任务
node bin/mesh.js probe hermes-local
node bin/mesh.js send hermes-local "用一句中文说明你是什么、当前工作目录在哪"

# 真实端到端：审批闭环（Web API 全程驱动）
node bin/mesh.js serve --port 7359
node tools/verify-approval.mjs 7359 hermes-local

# ACP over SSH 路径（传输层由 tools/fake-ssh.mjs 顶替，见 3.4）
node tools/verify-ssh-acp.mjs

# A2A：内置一个真实 A2A v1.0 服务端，证明客户端；也可指向真实端点（见 3.7）
node tools/verify-a2a.mjs
node tools/verify-a2a.mjs --url http://<host>:9900 --token <token>

# 真机验收：局域网 NAS 上的真实 Hermes（见 3.6）
$env:AGENTMESH_HOME = "D:\工作\.agentmesh"
$env:MESH_ASKPASS_SECRET = '<NAS 登录密码>'      # 仅密码认证的主机需要
node tools/verify-lan.mjs --node nas-hermes --dir /srv/work --log logs/lan-acceptance.txt

# 本地编排 Agent：一句话 → 自己决定派给谁（见 3.8）
node tools/verify-agent.mjs --log logs/agent-acceptance.txt
$env:AGENTMESH_LLM_BASE_URL = 'http://<网关>/v1'
$env:AGENTMESH_LLM_MODEL    = 'deepseek/deepseek-v4-pro'
$env:AGENTMESH_LLM_API_KEY  = '<key>'            # 或用 mesh agent save + --api-key-env
node bin/mesh.js agent "让 nas-hermes 写一个判断素数的 Python 函数，并把完整代码返回给我"

# 控制面：用浏览器那套 HTTP 调用打真控制面 + 真 NAS（见 3.9）
$env:NAS_SSH_PW = '<NAS 登录密码>'               # 只进内存，不落盘
node tools/verify-console.mjs --host 10.0.0.5 --port 2222 --user user

# 控制台界面的静态自检（不需要网络，也不需要真节点）
node tools/check-ui.mjs
```

> 密码型主机为什么需要 `MESH_ASKPASS_SECRET`、它为什么不会泄进控制面进程，见 3.6。

---

## 2. 测试结果（全部通过）

| 测试文件 | 用例 | 通过 | 覆盖内容 |
|---|---|---|---|
| `test/protocol.test.js` | 29 | 29 | ACP nd-JSON 分帧、更新分类、权限选项与响应结构、StopReason→状态映射、A2A 线格式（钉住 Hermes 形状）、SSE 解析、JsonRpcPeer 双向调用、挂起式（异步）inbound 处理器、**`isPrivateHost` 私网地址判定**、**`prefersLegacyMethods` 协议版本选名**、**`isMethodNotFound` 识别 -32601**、**`withConversationHistory` 历史折叠（新消息必须排在最后）** |
| `test/args.test.js` | 23 | 23 | argv 解析：可重复 flag 真的取值、缺值时报错而非静默存 `true`、`--` 终止、`=` 形式、布尔 flag 不吞下一个 token、`no-` 取反、短 flag、SSH 透传 flag 累积、`envPairs` 容错；**两例遍历所有布尔开关，断言它们绝不吞掉紧随其后的提示词（缺陷 29），并钉住 `--tools` 取值而 `--allow` 仍是无值开关（缺陷 30）**；**`--unset` 可重复且不落成位置参数、`--ssh-clear-secret` 是布尔开关、值型参数缺值会解析成 `true`（这是缺陷 42 的机制，测试钉住的是"行为如此"而非"行为正确"）、以及"不存在可以携带 SSH 密码本身的命令行参数"（缺陷 37/43 的正面约束）**；**外加一例针对缺陷 45 的回归测试：`valuelessFlags()` 不得把 `--local` / `--shell` 这类**真正合法的开关**误报成"缺值"**；**外加三例针对缺陷 50 的 `nodeInputFromFlags` 映射测试：① 指定密码来源必须关掉 `BatchMode`（否则凭据永远花不出去）、显式 `--ssh-batch-mode` 仍然优先、没指定就**不要凭空造值**；② 只设置真正传进来的字段（`--ssh-port` 只改端口，不得顺手清掉命令或环境变量；节点**名字是位置参数而非 flag**，所以这个函数不该造出 `name`）；③ 密码环境变量的**名字**不得被变成命令行上的值** |
| `test/a2a-adapter.test.js` | 11 | 11 | 对**忠实复刻 Hermes A2A 服务端**的 mock 做真实 HTTP/SSE：Agent Card 发现、SendMessage、SendStreamingMessage、`append` 语义、input-required/failed 状态、contextId 续接；**默认续接不夹带历史**（避免对真维护上下文的对端重复喂料）；**`replayHistory` 时客户端自己带上历史——阻塞与流式两条路径都覆盖**（否则 `--stream` 会静默丢掉历史）；外加一个 v0.3 形状的对端（无 `supportedInterfaces`）：只用 `message/send`、`-32601` 后自动换名重试、**卡片宣告私网 RPC 地址时不被盲从**（这些行为都是从真实端点上观察到的，不是设想） |
| `test/opencode-adapter.test.js` | 2 | 2 | 对复刻 opencode v1.18.31 线格式的 mock：`/global/health` + `/doc` 自检、`prompt_async`+`/event` 流式、`?directory=` 作用域、权限挂起与作答 |
| `test/http.test.js` | 14 | 14 | HTTP 传输层：`authHeaders`（Bearer 优先于 Basic、默认用户、extra 透传）、`describeFetchError`（`ECONNREFUSED` 说"没人监听" vs `ETIMEDOUT` 说"防火墙丢包"、DNS 归类、未知 code 不吞、`HttpError` 原样透传、**取消（AbortError）绝不被改写成"不可达"**）、`withTimeout`（超时可与调用方取消区分） |
| `test/llm.test.js` | 14 | 14 | OpenAI 兼容客户端：工具调用响应归一化（含本地服务端真实会发出的几种变体）、坏的 `arguments` JSON 作为**数据**返回而不抛、`joinUrl` 斜杠处理、`llmReady` 精确指出缺什么、**网关错误按响应体正文分流**（该网关对四种完全不同的失败一律返回 401，只看状态码必然误诊）、无 key 时不发 `authorization`、无工具时不发 `tools`/`tool_choice`、真实 HTTP 上的请求形状与 `listModels` |
| `test/orchestrator.test.js` | 16 | 16 | 编排循环：工具集按策略裁剪（只读策略下**不含**派发工具）、系统提示带上真实节点与能力、**工具失败作为数据回喂而非中断**、`dry-run` 不派发不写库、人工拒绝后不派发、`maxDispatches` 先判断后计数、未知任务 id 返回数据而不抛、步数上限报"未完成"且答复为空、派发结果落进共享 Store、`agent-*` 事件序列完整。全部经**真实 HTTP**（脚本化 LLM + 真实 A2A 对端），并在 `after()` 里销毁连接以便进程干净退出（缺陷 34） |
| `test/acp-lifecycle.test.js` | 3 | 3 | **真实子进程**（`test/helpers/fake-acp.mjs`）下的适配器生命周期：`probe()` 之后 `send()` 仍可用、连续两次 send 复用同一健康连接、主动断开不被误报为崩溃且可重连。沙箱内 3 例诚实跳过并说明原因 |
| `test/cli-cancel.test.js` | 5 | 5 | **真实子进程 + 桩 HTTP 服务器**：`mesh cancel` 在没有活动连接时**必须拒绝**且**不得改动任务记录**、对已终态任务是诚实空操作（exit 0）、未知任务是错误、有 daemon 时先问 daemon（`POST /api/cancel` 且带上 taskId）、daemon 返回 404 时正确报错。沙箱内 5 例诚实跳过并说明原因 |
| `test/approval.test.js` | 5 | 5 | 审批落库（可寻址资源）、批准/拒绝/超时、自动决策审计行、跨运行 requestId 复用、`listApprovals` 过滤语义 |
| `test/fleet.test.js` | 18 | 18 | 扇出目标选择：`capability` 字符串与数组、tag 当选择器用、`*` 与缺省、禁用节点不被隐式选中、显式 refs 优先；**外加密钥隔离那一组：密码只进内存不落盘（`sshPassword` / `ssh.password` / ssh 节点上的 `password` 三种写法一律被隔离，见缺陷 37）、opencode 的 `password` 仍然照旧落盘（隔离是有边界的，不是一刀切）、`ssh.passwordEnv` 存的是名字并从环境变量读值、`runtimeNode()` 返回带密码的副本而存档节点保持干净、`update()` 合并 `ssh` 且 `unset` 能删字段（缺陷 43）、删节点时一并丢弃内存中的密码、以及"文件里已经存在的明文密码在加载时就被洗掉，而节点仍然能用"**；**另 5 例针对"远端停下来等人做决定"（缺陷 61）**：停在等待态的任务必须发出 `needs-input`，**带上对端原话**（操作员凭原话决定，不凭摘要）与一条可照抄的回答命令，且**排在 `done` 之前**（实时观察者要按正确顺序看到）；完成的任务**不得**谎称在等人；**对端一句话都没说时也必须报告**（沉默正是最不能发生的那件事）；`--approval` 打在**没有权限通道**的传输上**必须**发出点名传输、点名原因、点名出路的警告，而有通道的传输**必须一点噪音都没有**（后一例同时断言策略真的被设进了适配器，否则"不警告"可以靠"什么都没做"而通过） |
| `test/shared-context.test.js` | 5 | 5 | **跨节点共享上下文（缺陷 60）**：默认**一个节点绝不会听到另一个节点的任何东西**（断言对端收到的文本与提问逐字相同）；`shareContext` 打开后对端能看到别的节点问了什么、答了什么、来自哪个节点，且这段文字有明确的起止围栏、**声明"这不是你自己的历史"**、真实请求**排在围栏之后**（对端必须先读到真正要做的事）；被共享的上下文里**不含目标节点自己**；**落库的任务记录仍是用户原话**（`mesh task` 读回来不该是一屏别人的历史）；超长往来会被截断并留下可见的截断标记，无答案的轮次（`result` 为空）**不参与**共享——那会给对端一个"没人回答过的问题"，读起来像它没做；`shareLimit` 生效且保留的是**最新**几轮；`recentTurns` 按时间正序返回且能排除指定节点 |
| `test/secrets.test.js` | 10 | 10 | **跨重启保存的密码（缺陷 57）**：带空格/`$`/`#`/单双引号的密码**逐字往返**（一个被悄悄改掉的密码是没人能调试的那种故障）；**重复加载不得把文件自己的值说成"来自环境"**（启动时加载一次、`mesh secrets list` 再加载一次，第二次曾把每个条目都报成 `shadowed by the environment`，而那些变量根本没人设过）；操作员**真正设了**的环境变量优先于文件；POSIX 下文件建成 **0600**（Windows 上 mode 不是权限模型，保护来自用户目录的 ACL，故只在非 Windows 断言）；**无法逐字往返的值一律拒绝**而不是写坏（含换行的值会追加出第二个赋值、同时含两种引号的值无法无歧义地引用）、非法变量名拒绝、空值拒绝，且失败时**什么都没写**；改一个条目保留其余内容**包括注释**，删两次第二次如实返回"已经不在了"；**端到端那条**：文件加载进环境后，节点按 `ssh.passwordEnv` 指的名字真的解析出了密码，而 `nodes.json` 的**原始字节**里只有变量名、没有密码；**另两例是拿真实 CLI 打一个故意写坏的文件时发现的**：手改出的 `NAME="p@ss`（引号未闭合）在"不做转义处理"的前提下**没有任何正确读法**——照字面读出来的密码就是 `"p@ss`，操作员随后会收到主机的 `permission denied`，然后去查主机、查节点、查 SSH 设置，**唯独不会去看那个文件，因为他知道自己写的是什么**。所以这一行被标为 `problem` 而**不加载**（宁可"没有可用密码"——那条错误信息会直说没有密码——也不要"用一个错的密码"），`mesh secrets list` 会点名它（`NOT USED — unterminated quote (fix the line, or re-set it: mesh secrets set NAS_SSH_PW)`），而**写一次这个条目就是修复它的方式**（第二例钉住这条）。夹在**中间**的引号（`abc"def`）是普通字符、照旧可用——只有"开头是引号且从不闭合"才是有歧义的 |
| `test/web.test.js` | 20 | 20 | 控制面（`node:http` 起真正的服务，用 `fetch` 按浏览器那套调用打它）：节点字段完整落盘（用户名/端口/远端命令/工作目录，见缺陷 36）、**密码不写进 `nodes.json`**（对原始字节断言）、也**不回落到 `token`**（缺陷 37）、`GET /api/nodes` 不回显密码、`update` 只改给定字段（只改端口不能把用户名或命令弄丢，缺陷 38）、编辑后**失效适配器缓存**（缺陷 38）、`/api/agent/config` 只把地址与模型落盘而密钥不落（缺陷 40）；**外加一例钉住"update 里没提的字段必须原样保留——包括一个只用于展示的 `kind`"（缺陷 47）**；**外加一例（缺陷 51）对 `GET /` 真正发出去的字节做排版断言**：`<fieldset>`/`<legend>` 分组存在、**行内 `style="…"` 一个都不许有**、每个控件都有标签、`#a-http-fields`/`#a-ssh-fields` 存在、`:focus-within` 与 `prefers-color-scheme` 存在、且**页面自己脚本里的每个 `$('id')` 都能在发出去的字节里找到**——最后这一条同时守住另一个陷阱：`createConsole` 在启动时把 `ui.html` 读进内存，**改了文件不重启控制台，发出去的还是旧页面** |
| `test/store.test.js` | 9 | 9 | 任务先落库后派发、事件 seq 单调与 `?after=` 重放、`lastSession` 续接、崩溃恢复对账、旧库迁移、统计、**`historyForContext` 按时间正序重建会话（跨节点/跨 context 不串味、无答案的轮次只出提问）** |
| `test/ssh.test.js` | 17 | 17 | `shellQuote` 注入防护与往返一致性、`cd ... && exec` 构造、env 走 `exec env` 而非裸前缀、一次性命令不走 `exec` 而走 `sh -c`、alternate ssh binary 与前置参数、`batchMode:false` 与 `-o` 透传、Windows 批处理 ssh 被拒；**外加 `askpassChildEnv` 那两条（缺陷 49）：有密码时给出 `{MESH_ASKPASS_SECRET: ...}`、无密码时给出 `{}`（而不是 `{MESH_ASKPASS_SECRET: undefined}`——那会把字符串 `"undefined"` 塞进子进程环境），并断言 `tools/ssh-askpass.mjs` 真的读这个名字、且设置了 `SSH_ASKPASS_REQUIRE`；以及"密码绝不出现在 argv 或远程命令行里"（argv 是本机任何进程都能通过 `ps` 读到的，这正是密码会泄漏的那条路径）** |
| `test/net.test.js` | 4 | 4 | **fetch 不可连接的端口（缺陷 46）**：禁止列表包含引发 flake 的那些端口、**硬编码列表与当前 Node 的实际行为仍然一致**（实测而非凭记忆，Node 升级后表格若漂移这条会失败而不是变成幽灵问题）、连续 40 次 `listenOnFetchablePort` 都拿不到禁止端口且每次都真的 fetch 通、掷不到可用端口时报错而不是死循环（用**注入的判定函数**测，不改导出的那份列表）。**"可连接的端口样本"必须运行时取而不能写死**（缺陷 52）：这条用例最初把 `7331` 写成样本，而那是本程序控制台的默认端口，于是只要控制台在跑，全量测试就死在 `EADDRINUSE` 上、后面 10 个文件一个都不会执行 |
| `test/ui-events.test.js` | 12 | 12 | **事件配色表与事件词表的双向一致性（缺陷 53）**：每个能发出的事件（`src/protocol/events.js` 的 `EventType` 14 种，加编排器、`web/server.js` 与**页面自己**送到浏览器的 `agent-*`）都必须有 `.ev-*` 配色；每条 `.ev-*` 规则都必须对应一个真能发生的事件（这一条抓出了 7 种没配色的事件和 2 条永不匹配的死规则）；第三例**守住前两例**——断言词表仍有 20 种以上，否则将来把枚举清空，前两例会拿两个空集合比对而**空洞地通过**。`agent-result` 刻意**不**收录：它是 `src/cli/main.js` 里 `mesh agent --json` 写往 stdout 的记录，永不进浏览器。**词表有三个来源而不是两个**（缺陷 58）——页面自己会发 `agent-user`（对话里"你"那一行）与 `agent-error`（页面自己的请求失败），只从服务端读词表会把它们判成死规则并删掉配色，这正是 `agent-user` 遭遇到的事。**另 3 例针对流式碎片合并（缺陷 56）**：把页面里**真正的** `appendLog` 源码抽出来（抽取失败即断言失败，避免正则空匹配导致空洞通过），在桩 DOM 上跑——① 8 个单字符碎片必须落成 **1 行**且文字完整拼接，且一个完整事件必须断开这段流、不同 node/task 必须另起一行；② 面板被清空后，碎片**不得**被追加到已经脱离文档的那一行上（否则文字会无声消失）；③ 页面里的 `STREAMING_LOG_TYPES` 必须与协议里的 `STREAMED_EVENTS` 完全一致，这样将来协议新增一种流式事件，测试会红，直到面板学会合并它。**又 4 例针对对话面板的过程折叠（缺陷 59）**：同样把页面里真正的 `appendAgent` 抽出来跑——① 一轮完整的 `agent-start`→思考→调用→结果→派发→答复必须落成**三个顶层元素**（你的话 / 折叠的「过程」/ 答复），**答复不得在折叠里面**，折叠默认 `open === false`，而**摘要行要报出被隐藏的条数**（"思考 2 · 调用 1 · 结果 1 · 派发 1"）——把细节藏起来可以，把"它做过事"这件事一起藏掉不行；② 两个显示开关（思考 / 工具）真的决定折叠里放什么，且关掉工具时**摘要仍然计数**；③ 一个没有 `agent-start` 的过程事件（重连、续流）也必须落进折叠，而不是散在答复之间；④ **每一个 `agent-*` 事件都必须被显式分类**（要么进折叠、要么进"始终可见"），因为 `appendAgent` 对不认识的类型静默忽略——将来加一种新事件，它会在面板里**无声消失**，没有任何地方会报错。**再 2 例针对"来源靠人记"这个根因（缺陷 62）**：词表的来源改为**遍历 `src/` 整棵树**（唯一的目录级排除是 `src/cli/`，因为它是事件的消费者兼 stdout 记录的生产者），并且新增一例**把前提本身钉住**——断言扫到的文件数 ≥ 20、页面在来源里、`agent-user` 在词表里（缺陷 58 的正面约束）、`agent-result` **不**在词表里（缺陷 53 的判定）、扫到的内容**不含** `reportAgentRun`（排除规则本身）；**另 1 例针对"远端停下等人"在控制台的样子（缺陷 61）**：桩 DOM 跑真的 `appendLog`，断言 `needs-input` 拿到最抢眼的那个类、**对端原话被显示**、并且**告诉浏览器用户在这一页怎么回答**（选同一节点 → 勾「续接上次会话」→ 填回答），而**没有 `contextId` 时给的是另一句提醒**（回答可能会开一段新会话） |
| **合计** | **217** | **217** | 上表按**完整运行**计（提权后 217/217）。在受限沙箱内，`acp-lifecycle` 的 3 例与 `cli-cancel` 的 5 例会**诚实跳过并说明原因**（即 209 通过 + 8 跳过），而不是伪装成通过。沙箱内另有一条边界：`node --test`（runner 模式）需为每个文件 spawn 子进程，会被拒绝，故受限环境下按上表逐个文件执行——两者结果一致 |

---

## 3. 真实端到端验证

### 3.1 ACP 通道 + 能力探测（真实 Hermes）

`node bin/mesh.js probe hermes-local` 实测返回：

```json
{"connected":true,"protocolVersion":1,
 "agentInfo":{"name":"hermes-agent","version":"0.21.3"},
 "capabilities":{"loadSession":true,"promptCapabilities":{"image":true},
   "sessionCapabilities":{"fork":{},"list":{},"resume":{}}},
 "authMethods":[
   {"id":"custom","name":"custom runtime credentials","description":"Authenticate Hermes using the currently configured custom runtime credentials."},
   {"id":"hermes-setup","name":"Configure Hermes provider","type":"terminal","args":["--setup"],
    "description":"Open Hermes' interactive model/provider setup in a terminal. Use this when Hermes has not been configured on this machine yet."}]}
```

说明 ACP 握手、版本协商（v1）、能力与鉴权方式解析均正确。

### 3.2 真实发任务（真实 Hermes）

`node bin/mesh.js send hermes-local "…"` 实测返回正文：

```
我是 Hermes Agent（Nous Research 开发的智能体），当前工作目录是 D:\工作。
```

任务记录：`completed`，28 个事件，耗时 13.8s，会话 id 已捕获并落库。

### 3.3 审批闭环（`tools/verify-approval.mjs`，全程只走 Web API）

最后一次运行 **15/15 通过**（`bootId=boot_29eb48afda684bdd`，`taskId=task_dd017d306f9b46cd`），原始输出：

```
PASS  console /healthz reachable — bootId=boot_29eb48afda684bdd pid=5048
PASS  console serves the SPA at / — 17754 bytes
PASS  node 'hermes-local' is registered — hermes/acp
PASS  SSE /api/stream delivers an event-stream — status=200 type=text/event-stream
PASS  POST /api/send accepted the task — taskId=task_dd017d306f9b46cd status=202
PASS  agent parked a session/request_permission (durable + queryable)
      — "Approve edit: D:\工作\probe-approved-mu9ufq2f.txt"
        options=[allow_once:allow_once, reject_once:deny] status=pending
PASS  the parked approval is live on the holding connection — live=true
PASS  the edit has NOT happened yet (nothing ran without approval) — absent, as expected
PASS  POST /api/approvals/:id resumed the agent — http=200 {"ok":true,"optionId":"allow_once"}
PASS  task reached a terminal state — state=completed
PASS  task completed successfully — state=completed
PASS  the task result text is stored, not lost — result="done"
PASS  approved edit took effect on disk
      — probe-approved-mu9ufq2f.txt: hello from agentmesh mu9ufq2f
PASS  event log recorded the whole lifecycle
      — seen=[task-created, task-state, log, usage, thought, tool-call,
              approval-requested, approval-resolved, tool-update, chunk, done]
PASS  the approval is durably recorded with its outcome — status=approved optionId=allow_once
```

这条链路证明了完整设计意图：**派发 → 智能体请求授权 → 挂起并落库 → 在控制面远程作答 →
智能体真的执行了被授权的写文件动作 → 结果与全部事件归档**。其中
"the edit has NOT happened yet" 与 "took effect on disk" 成对出现，
排除了"其实没走审批、agent 自己绕过去"的假阳性。

### 3.4 ACP over SSH 路径（`tools/verify-ssh-acp.mjs`）

本机没有 sshd（非管理员，装不了 OpenSSH Server；WSL 无发行版；无 Docker；无 `~/.ssh`），
所以 **ssh 传输本身被 `tools/fake-ssh.mjs` 顶替**。该 shim 以真实 ssh 客户端的 argv 形状被调用
（经节点的 `ssh.binary` + `ssh.binaryArgs` 接入），然后按 POSIX 语义执行 AgentMesh 拼出的
远端命令行，stdio 直接继承——也就是说，它顶掉的只有 TCP/认证/加密，**AgentMesh 负责的一切
都真的跑了一遍**。最后一次运行 **13/13 通过**：

```
PASS  mesh node add --ssh-binary accepted the SSH node
PASS  ACP handshake completed through the SSH path — agent=hermes-agent v0.21.3 protocol=1
PASS  the ssh client was actually invoked — 1 invocation(s)
PASS  destination came from the node config — destination=shim@127.0.0.1
PASS  ssh flags are the ones buildSshArgs produces
      — -o BatchMode=yes -o ConnectTimeout=10 -T -p 2222 -i /home/shim/.ssh/id_ed25519
PASS  the alternate ssh binary received its shape intact — no stray args before the ssh flags
PASS  the remote command is `cd <cwd> && exec env <K=V> <program>`
      — cd 'D:\工作' && exec env AGENTMESH_SSH_PROBE=mesh_probe_mu9uztm5 '…\hermes-acp.exe'
PASS  cwd was parsed back out of the quoted word — cwd="D:\\工作"
PASS  the agent program resolved to the configured command
PASS  node --env values reach the remote process — env={"AGENTMESH_SSH_PROBE":"mesh_probe_mu9uztm5"}
PASS  a task completed over the SSH path
      — exit=0 state=completed eventTypes=[task-created,task-state,log,usage,chunk,done]
PASS  the agent returned real text through the ssh pipe — 我是由 Nous Research 开发的 Hermes Agent 智能助手。
PASS  the send opened its own ssh session — 2 total invocation(s), 1 during probe
```

**这条验证的价值在于它逼出了 SSH 分支里从未被执行过的代码**（`acp.js` 的 `#startProcess`
在 `node.ssh` 存在时走的 `sshProcess` 路径）。顺带证明了单引号转义在含非 ASCII 的 Windows
路径 `D:\工作` 上能正确往返。

### 3.5 一个负面结论（同样有价值）

Windows 上不能把 `AGENTMESH_SSH` 指向 `.cmd`/`.bat` 包装脚本，**而且幸好没有"顺手修好"**：

- 不加 `shell: true`：Node 直接 `spawn EINVAL`（`.bat`/`.cmd` 不允许直接执行）。
- 加 `shell: true`：实测 argv 被 cmd.exe 重新切分 —— `-o BatchMode=yes` 变成两个参数，
  远端命令在第一个空格处断掉，`&&` 还被本地执行了（`'exec' is not recognized as an
  internal or external command`），实测收到 13 个参数而正确值是 9 个。

也就是说，**任何为了绕过 EINVAL 而打开 shell 的"修复"都会静默破坏每一条远端命令**。
现在 `sshProcess` 会明确拒绝这种 ssh binary 并说明原因（有单测钉住）。

### 3.6 真机验收：局域网 NAS 上的真实 Hermes（`tools/verify-lan.mjs`）

前 3.1–3.5 节里的"真实"都止步于**本机**：真实 Hermes、真实 CLI、真实 Web API，但 SSH 传输由
`tools/fake-ssh.mjs` 顶替。本节是唯一一次**跨机器**的实跑：控制面在 Windows（10.0.0.9），
智能体在局域网 NAS（10.0.0.5），中间是真实 sshd、真实登录、真实网络。

**35 / 35 通过**，0 失败。完整转录：`logs/lan-acceptance.txt`。

#### 3.6.1 现有环境（勘察结论，与预期不同）

| 项 | 实测 |
|---|---|
| SSH | `10.0.0.5:2222`，`publickey,password`；**没有** `~/.ssh`，`/home/user` **不存在**（登录时 sshd 每次都警告 `Could not chdir to home directory`） |
| 认证 | **只可能用密码**：没有家目录就没法放 `authorized_keys`；`sudo` 用登录密码可用，但 sudo 凭据**不跨 SSH 会话**（实测新会话 `sudo -n` 直接失败），所以 `sudo -n` 这条近路不通 |
| SSH 转发 | `/etc/ssh/sshd_config.d/trim_sshd.conf` 里 `AllowTcpForwarding no` |
| Hermes | 应用商店版，**跑在独立系统用户 `hermes` 下**：Go wrapper + `hermes dashboard --host 127.0.0.1 --port 18080`，数据目录 `/opt/hermes/data`（mode `700`）。`hermes-acp` 确实存在：`/opt/hermes/bin/hermes-acp` → `acp_adapter.entry:main`，版本 **0.18.0**（比本机 0.21.3 旧） |
| 目标目录 | `/srv/work` 存在且 `user` 可写；权限位显示为 `d---------+`，实际由 **ACL** 放行（`getfacl` 确认） |
| 远端 node/python | **无 node/npm/uv**；只有系统 `python3` 3.11.2 和 Hermes 自带运行时 python 3.11.15 |

也就是说：**用户说的"Hermes 装好了、能用"，指的是那个沙箱化的应用**，它的数据目录属于
`hermes`。以 `user` 身份运行 `hermes-acp` 必须自带一个数据目录，这是本节的第一个设计约束。

#### 3.6.2 为跑通所做的两件事（都不改 NAS 上的任何持久配置）

**其一，密码认证走 `SSH_ASKPASS`，且不让密码进控制面进程。**
OpenSSH 可以从"助手程序"取密码而**不读 stdin**——这点很关键，因为 ACP 的稳定传输就是 stdio，
密码提示一旦读到 stdin 就会污染协议流（这也正是 `BatchMode=yes` 是默认值的原因）。
但 `SSH_ASKPASS` 只能是一个路径、不能带参数，Windows 上唯一通用的解释器是 `node.exe`，
于是必须靠 `NODE_OPTIONS=--require <askpass.cjs>` 预载一个只打印密码就退出的脚本。
**而 `NODE_OPTIONS` 会被继承**：如果直接在 shell 里 export，`mesh` 自己会预载那个脚本并把密码
打到自己的 stdout 上。所以加了一层 ssh 包装器 `tools/ssh-askpass.mjs`，把 `NODE_OPTIONS` 的作用域
**收窄到 ssh 子进程**；节点注册为：

```powershell
mesh node add nas-hermes --kind hermes `
  --ssh 10.0.0.5 --ssh-user user --ssh-port 2222 --ssh-batch-mode no `
  --ssh-binary "<node.exe>" `
  --ssh-binary-arg "<repo>\tools\ssh-askpass.mjs" `
  --ssh-binary-arg "C:\Windows\System32\OpenSSH\ssh.exe" `
  --ssh-opt "UserKnownHostsFile=<repo>\.ssh\known_hosts" `
  --ssh-opt "StrictHostKeyChecking=accept-new" `
  --command /opt/hermes/bin/hermes-acp `
  --cwd /srv/work `
  --env HERMES_HOME=/tmp/mesh-hermes --env HOME=/tmp/mesh-hermes `
  --approval ask
```

密码只存在于**进程环境变量**（`MESH_ASKPASS_SECRET`）里，**没有**写进 `nodes.json`，也没有落盘；
实测包装器运行后父 shell 的 `NODE_OPTIONS` 仍为空。密钥认证是更该走的长期方案，但在这个 NAS 上
需要先用 `sudo` 建 `/home/user`——那是对用户系统的持久改动，因此本次**没有做**。

**其二，远端 Hermes 数据目录放 `/tmp`。**
`/tmp/mesh-hermes/` 里把 `config.yaml` 与 `.env` **符号链接**到应用自己那份，
于是既不复制密钥、也**完全不碰正在运行的 dashboard 应用的 `state.db`**（与它共享状态库会有并发写
风险）。`HERMES_HOME` 与 `HOME` 都指向这里，绕开"家目录不存在"的问题。代价是重启后需要重建——
如果要做成常驻，把该目录换成 `/srv/` 下的持久路径即可。

#### 3.6.3 实跑结果

```
1. live ACP handshake over SSH
  ok   connected  protocolVersion=1
  ok   agent identified itself  hermes-agent 0.18.0
2. real task dispatched with policy allow-once
  ok   task completed  state=completed
  ok   a session id was established  111cd57c-7704-4c10-84d7-d72238520c55
  ok   reasoning/thought updates flowed / tool calls flowed
  ok   policy allow-once answered it without an operator  auto=true
  ok   the request carries the agent's own justification  Approve edit: /srv/work/agentmesh-hello.txt
3. artifact verified on the remote filesystem (not from the agent's summary)
  ok   remote read exited 0 / remote cat exited 0
  ok   contains the Hello world sentence / names the operating account / the managing host / the SSH port
  ok   md5 computed remotely  4056397faf9130e3ad038da02ee97470
  ok   the bytes streamed back over ssh hash to the remote digest
  ok   the artifact was (re)written by this run  8s old
4. real remote approval parked and resolved by a human decision
  ok   an approval request reached the console while the task was parked
  ok   the decision was made from the event loop, not after the fact
  ok   the parked request is addressable by task id  task_2e3897a3267d42b8
  ok   this one was NOT auto-approved (an operator chose)  auto=undefined
  ok   the approved write took effect on the remote disk
```

两个值得单独指出的点：

- **产物是独立核对过的，不是听 agent 自述**。第 3 节直接通过同一条 SSH 通道读远端文件系统：
  内容逐条比对、`md5sum` 与"流回来的字节在本地重算的 md5"必须相等（这能抓出管道层面的编码/换行
  损坏），再用 `mtime` 证明文件是**本次运行**写的而不是上一轮的遗留。只有这些全过了，才允许
  "文件已创建"这个结论成立。
- **审批的两条路径都验到了，而且触发者不同**：`allow-once` 那次是策略自动放行（`auto=true`）；
  `ask` 那次请求**真的挂起**，由事件循环外的"人"在 1.5 秒后作答，任务才继续（`auto=undefined`）。
  两次审批的 `title` 都是**远端 agent 自己给的理由**，不是测试夹具编的。

#### 3.6.4 一个意外收获：Hermes 自己的安全扫描会拦中文

第一次实跑时，Hermes 的 `tirith` 预执行扫描把写入命令判成
`[HIGH] Confusable Unicode characters in text`——理由是"文本里出现了与 ASCII 视觉等同的 Unicode
字符，疑似同形字攻击"。真实原因是那段 here-doc 同时含中文和 ASCII 命令。**这是误报**，但它带来一个
有实际意义的运维结论：**在 Hermes 上通过 shell 命令书写 CJK 文本会触发审批**。运维要么用
`ask` 人工放行，要么用 `fs/write_text_file` 之类的非 shell 通道。

### 3.7 A2A 通道：真实服务端验证 + 一个真实不可达端点的完整诊断

A2A 是四条通道里唯一**只对 mock 验证过**的（第 5 节第 3 条）。这一节把它推进了两步。

#### 3.7.1 对着一个真实 A2A 服务端跑通（`tools/verify-a2a.mjs`，23/23）

`tools/fake-a2a-server.mjs` 是一个**真的 A2A v1.0 服务端**（真 `node:http`、真 JSON-RPC、真 SSE 分帧），
不是把传输层打桩的 mock：它强制 bearer 鉴权、把卡片放在非根路径的 RPC 上、并同时支持
`task` 形状的阻塞响应与流式 artifact。用它把整条 Fleet 路径跑通：

```
1. the embedded server actually requires auth
  ok   an unauthenticated card request is refused  status=401
  ok   a wrong token is refused  status=401
2. Agent Card discovery (embedded)
  ok   card fetched  hermes-b v1.0.0-test
  ok   card advertises a JSONRPC interface  JSONRPC v1.0
  ok   the card drove the streaming path  true
4. the auth + protocol headers we actually send
  ok   Authorization: Bearer <token>  Bearer CHANGE_ME
  ok   A2A-Version header is sent  1.0
5. SendStreamingMessage over SSE (artifact append semantics)
  ok   the appended artifact fragment was concatenated, not replaced  "echo[stream]:ping +tail"
6. SendMessage (blocking) with a task-shaped result
  ok   the task artifact text came back as the result  "echo[blocking]:ping"
7. the card's RPC url is honoured, not assumed
  ok   every RPC went to the advertised path  /rpc
```

其中第 5 条特别值得留：流式 artifact 的 `append` 语义**必须**拼接而不是替换。
第 1、2 条则是"测试装备本身也要被测试"——服务端真的会 401，所以"带对了 token"是个有效断言。

`mesh probe` 的 **a2a 渲染分支此前从未在真实卡片上执行过**，这次也补上了（CLI 端到端）：

```
$ mesh probe a2a-local
✓ a2a-local: reachable
  card      hermes-b v1.0.0-test — AgentMesh
  rpc       http://127.0.0.1:9901/rpc
  interface JSONRPC v1.0
  streaming true   push=false   auth=true
  skills:
  - Echo: returns what you send  [test]

$ mesh send a2a-local "hello from the AgentMesh CLI"
completed  task=task_5499d17bd82840ac  context=ctx_srv_1  170ms
echo[stream]:hello from the AgentMesh CLI +tail        ← 响应确实回来了，退出码 0
```

**这说明"我们这侧"是通的。** 它不证明真实对端也这样说话——见下。

#### 3.7.2 一个真实的第三方公网 A2A 端点：从不可达到打通

真正的收获来自一个**真实的第三方公网端点**（`123.56.124.199:9900`，一台云上 Hermes 的 A2A 桥）。
整个过程经历了三个依次暴露的阶段，每一阶段都抓出了一个真实缺陷：

**阶段一：端口被防火墙丢包。** 最初 `mesh probe` 只回一句 **`error: fetch failed`** ——
完全无法归因（见缺陷 24，已修）。修好之后：

```
error: cannot reach http://123.56.124.199:9900/.well-known/agent-card.json:
  UND_ERR_CONNECT_TIMEOUT — the connection attempt timed out with no reply — a firewall
  or cloud security group is DROPPING packets to this port (a merely-closed port would
  be refused instead)
```

这个结论不是猜的，是靠**端口对比**得到的：

| 端口 | 结果 | 含义 |
|---|---|---|
| 22 | **OPEN** | 主机本身可达 |
| 80 | **OPEN**（nginx/1.31.1） | 有服务在跑，且外部能访问 |
| 443 | **ECONNREFUSED** | 包**到达了主机**，主机回 RST：只是没人在听 |
| 9900 / 3000 / 8000 / 19119 | **超时（无 RST）** | 包在到达主机之前被**丢弃** |

关键就在于 **443 是"拒绝"而 9900 是"超时"**：如果 9900 只是没人监听，它会和 443 一样被拒绝。
收不到任何回应只可能是中间有东西在 DROP。**因此这是网络策略问题，不是 A2A 协议问题。**

**阶段二：卡片宣告了一个内网地址。** 安全组放行后，TCP 与卡片发现都通了，但派发任务失败：

```
card      hermes-b v0.14.0 — user
rpc       http://172.24.225.207:9900/          ← 卡片里写的是内网地址
interface legacy
streaming false   push=false   auth=true
...
FAIL task completed  state=failed
  error=cannot reach http://172.24.225.207:9900/: UND_ERR_CONNECT_TIMEOUT — …
```

`172.24.225.207` 是 RFC1918 私网地址，公网根本到不了——**服务端在卡片里报了自己的内网地址**
（见缺陷 26）。修复后客户端不再盲从，改用"取到卡片的那条已证实的通路"，并在 `mesh probe` 里告警：

```
rpc       http://123.56.124.199:9900
  ! the Agent Card advertises its RPC endpoint at http://172.24.225.207:9900/, which is
    a private address; using http://123.56.124.199:9900 instead, because that is the
    address the card was actually reachable on. Fix the agent's public URL setting to
    silence this.
```

**阶段三：对端说的是 v0.3 的方法名。** 地址修对之后，对端终于回了一个**规范的 JSON-RPC 错误**：

```
✖ peer 'hermes-b-a2a' rejected the task: Method not found: SendMessage
```

这是一张 `legacy` 卡片（没有 `supportedInterfaces`），只实现 v0.3 的 `message/send`
（见缺陷 27）。修复后——**打通了**：

```
$ mesh send hermes-b-a2a "你好 hermes-b，我是从 C 电脑上的 AgentMesh 发来的。请回一句话确认你收到了。"
completed  task=task_a52e54a3e5ee4f8d  context=409bb61d-75e6-4f99-9f8c-b4c050699b79  217ms
[hermes-b placeholder] received 49 chars: '你好 hermes-b，我是从 C 电脑上的 AgentMesh 发来的。请回一句话确认你收到了。' — connectivity OK. Real agent inference is not wired up yet.
```

`node tools/verify-a2a.mjs --url http://123.56.124.199:9900 --token …` → **10/10**。

**这一节的结论**：AgentMesh 的 A2A 通道已经对着一个**别人写的、真实的第三方 A2A 实现**端到端跑通，
并且这个过程中抓出的三个问题（无法归因的网络失败、卡片里的私网地址、协议版本话术差异）
**都是真实部署里必然遇到的**，现在都已被产品吸收。

#### 3.7.3 一次真实的对话，以及"看起来是对话其实不是"

对端换掉占位符、接上真实模型后（卡片描述也更新为 "Hermes Agent bridge on the example site"，
且**卡片里的 RPC 地址已改为公网地址**，3.7.2 的告警消失），做了一次真正的多轮对话。

**第一次尝试暴露了第四个问题。** 用 `mesh send … --continue` 连发三轮，看起来像一次对话：

```
第 1 轮  →  你好，AgentMesh！我是部署在「烟雨站」服务器上的 Hermes Agent，代号 hermes-b…
第 2 轮  →  你好，我是部署在"烟雨站"服务器上的 Hermes Agent，代号 hermes-b…   ← 又自我介绍了一遍
第 3 轮  →  …本次我实际收到的问答只有上述第 1 轮（即你这条整理请求），
            此前轮次未进入我的会话上下文，故文档如实记录了已获取到的内容，未做虚构。
```

对端**诚实地否认了上下文**，于是让它"把我们这次对话存下来"存出来的**只有最后一轮**
（1312 字节，md5 `2925f7f3…`）。查库确认问题不在我们这侧：三次请求的 `contextId` 都是
`e59a438d-…`、都按规范放在 `params.message.contextId`，但**对端每次都新建了一个不同的
`remoteTaskId`** —— 它收下了 `contextId` 却没有据此重建会话（缺陷 28）。

**第二次尝试：让客户端自己带上历史。** 新增 `--with-history` 后重开一条干净会话（新 `contextId`），
并在第 2 轮**专门考它对上一轮的记忆**：

```
$ mesh send hermes-b-a2a "请回忆一下：我上一条消息里说我自己是从哪里来的？我用的这个管理工具叫什么名字？" \
    --continue --with-history
第一，你上一条说自己是「从 C 电脑上」发来的。
第二，你用的管理工具叫「AgentMesh」，一个统一管理多台服务器上不同 AI agent 的控制面。
```

**记忆测试通过**——这就是历史确实送达的直接证据（同一对端、同一 `contextId`，只是这次由客户端
把既往轮次折叠进消息）。第 3 轮让它把会话落盘，这次存下来的是**完整的三轮对话**
（2342 字节，md5 `94f17c27afb3f6961a4b1e281406066e`，对端还打出了覆盖旧文件的 diff）：

```
绝对路径：/root/agentmesh-conversation.md
字节数：2342
md5：94f17c27afb3f6961a4b1e281406066e
```

> **一处必须说清的验证边界**：这台云主机**只有 A2A 可达，没有 SSH 凭据**，所以"文件确实以该内容存在
> 于该路径"是**对端自述**（附它自己的写入 diff 与内容回显），**不是我们独立核对的**——这与 3.6 的
> NAS 验收不同，那里我们通过 ssh 把产物读回来算了 `md5` 与 `mtime`。要独立核验只需对该主机开一条
> SSH（或让对端把文件内容经 A2A 再发一次并比对摘要）。

**这一节的价值**在于它再次验证了本项目的核心信条：**"能在屏幕上看到一段像样的对话"不等于
"系统真的保持了会话"**。区别只有在主动去考它（记忆测试）、并且在它撒谎或不自知时去查库对账，
才会显现出来。

---

### 3.8 本地编排 Agent：一句话 → 自己决定派给谁（`tools/verify-agent.mjs`）

前七节验证的都是**人明确指定目标**的派发（`mesh send <node> "<prompt>"`）。本节验证的是需求里
真正想要的那件事：**在本机跑一个 Agent，对它说一句话，由它自己判断该把活派给哪台机器上的哪个
Agent**，再把结果带回来。

#### 3.8.1 确定性验收：28/28

`tools/verify-agent.mjs` 把两件会让结果不可复现的东西换成假的——**LLM**（脚本化，但走真实
HTTP 上的真实 OpenAI 工具调用协议）和**远端 agent**（一个真实的 A2A 对端，真实 HTTP）。其余的
`Fleet` / `Store` / 注册表 / 适配器 / 循环 / 权限闸门**全是产品代码路径**。

```
node tools/verify-agent.mjs
==== 28/28 checks passed ====
```

它逐条钉住的是：

| 断言 | 说明 |
|---|---|
| 一句话 → 恰好一次派发 | 且**只**发给模型选中的那个节点（另一个对端一次都没被碰） |
| 远端 agent 的答复**原样**到用户手里 | 代码块不被改写、不被转述 |
| 派发落在**同一个** Store 里 | 即 `mesh tasks` / Web 控制台看得见的那一份 |
| 送给远端的 prompt 是**自足**的 | 模型被明确告知对端看不到本对话，所以它必须把用户的意图展开，而不是原样转发 |
| 多节点请求会扇出并**收齐**两边的答复 | 答复里同时带着两个对端各自的说法 |
| 节点名写错会**自我纠正**并最终完成 | 错误作为数据回喂，而不是中断整次运行 |
| 对端爆炸时**如实报告失败** | 错误原文回喂；摘要里**不含任何编造的产物**；库里记为 `failed` |
| 权限闸门真的拦得住 | `dry-run` 不派发也不写库；只读策略**连工具都不暴露**；人工拒绝后一次派发都没发生 |
| 步数上限 = 未完成的运行 | 返回 `stopReason: 'step-limit'` 且 **`text` 为空**，CLI 以退出码 1 明确报"没做完"，而不是给出一个"空答案的成功" |

#### 3.8.2 真实端到端：对着真实 LLM 和真实远端 Agent

用**局域网上的真实 OpenAI 兼容网关**（`http://10.0.0.5:8000/v1`，71 个模型）驱动编排器，
模型选 `deepseek/deepseek-v4-pro`，下面是四次真实运行（非脚本）：

**（一）它自己查了节点清单。** 提示词只问了"现在有哪些节点可用？每个节点分别能做什么？"。
编排器先调 `list_nodes`，然后答出三个真实节点及各自传输方式（`2 steps · 1641 tokens`）。

**（二）需求里的原话——让 NAS 上的 agent 写一个函数。**

```
$ mesh agent "让 nas-hermes 这个节点用 Python 写一个判断素数的函数 is_prime，并把它的完整代码原样返回给我。"
→ send_task {"node":"nas-hermes","prompt":"请用 Python 写一个判断素数的函数，函数名为 is_prime…"}
  ✓ nas-hermes completed task=task_63b7357
nas-hermes 节点返回的完整代码如下：
```python
def is_prime(n):
    """判断整数 n 是否为素数，返回 True/False。"""
    if n < 2:            # 负数、0、1 都不是素数
        return False
    …
    i = 3
    while i * i <= n:    # 只需试除到 sqrt(n)，且只试奇数
        if n % i == 0:
            return False
        i += 2
    return True
```
— 2 step(s) · 1 dispatched · 1923 tokens
```

注意最后由编排器**主动转述的一句话**："远端代理在返回时注明，它拒绝了写文件和运行验证，所以这段
代码未经实际执行验证。" —— NAS 节点配的是 `approvalPolicy: ask`，无人应答时**默认拒绝**，于是
远端 agent 拒绝落盘与执行。编排器**没有把这件事藏起来**，而这正是需求里"各种权限怎么修改都没问题"
应该产生的可见后果：权限生效了，且用户看得见它生效了。

**（三）换一个传输方式，同一句话照样成立。** 把目标换成云上的 A2A 对端（`hermes-b-a2a`，背后是
真实 LLM），要一首四行诗。编排器改为走 A2A，拿到对端原话并原样带回（`1 dispatched · 1557 tokens`）。

**（四）失败路径也真跑过。** 在受限沙箱里跑（二）时，`spawn` 被沙箱拒绝，编排器收到
`spawn EPERM` → **重试一次** → 仍失败 → 然后明确回答："我没有伪造结果，也不会再静默重试。"
并给出排查建议、主动提出可以改派给其他节点。

> **这一步的取舍要说清**：上表（一）（三）（四）在受限沙箱内即可复现；（二）需要 SSH 到 NAS，
> 沙箱会拒绝 `spawn`，必须提权后运行（理由与 3.4/3.6 相同：真实子进程是这项验证的对象本身）。

#### 3.8.3 权限模型（这是本功能的核心，而不是附属）

"能不能改权限"是这个需求里最实际的问题，所以权限不是写在文档里的约定，而是**六个开关加上一道
默认拒绝的闸门**，全部在 `mesh agent` 上：

| 开关 | 效果 |
|---|---|
| `--dry-run` | 只出方案，不派发、不写库 |
| `--read-only` | 工具集里**根本不含** `send_task`/`broadcast`（不是"调用后拒绝"） |
| `--tools a,b` | 显式白名单；未知工具名**报错退出**，不会静默降级 |
| `--confirm` | 每次派发前在终端问一次；**stdin 非终端时默认拒绝**（无人值守的运行不能靠"提问无人回答"蒙混过关） |
| `--max-steps` / `--max-dispatches` | 双重上限；触顶如实报"未完成" |
| 节点自身的 `approvalPolicy` | 编排器**不覆盖**它——远端能做什么，仍然由远端节点自己的策略决定 |

最后一条是刻意的：编排器是**派发者**，不是权限的绕过者。实测（二）里 NAS 节点按自己的 `ask`
策略拒绝了写盘，编排器只能如实转述。

#### 3.8.4 Web 控制台

`POST /api/agent` 复用与 CLI 完全相同的 `runAgent()`；Agent 的推理事件（`agent-start` /
`agent-thought` / `agent-tool-call` / `agent-tool-result` / `agent-dispatch` / `agent-final`）
经 SSE 实时推送，控制台顶部的对话面板逐条渲染。已实测：`POST` 返回 202，SSE 收到 6 个 agent
事件，派发出来的任务随后出现在"最近任务"里（同一个 Store）。

> **一处刻意的设计**：Agent 的**推理不落库**，只有它**派发出去的任务**落库。
> 推理是过程，会过期；动作是审计对象，必须可查。这与"把 LLM 的思考过程当记录存起来"是两种东西。

---

### 3.9 控制面：注册表单、密钥隔离与编辑（`test/web.test.js` + `tools/verify-console.mjs`）

#### 3.9.1 这一节为什么存在

前面几节的验证几乎都是从 **CLI** 发起的。但用户报的第一个问题**完全出在控制面界面上**，
而且它同时是三个问题叠在一起（见缺陷 36/37/39）：

* 界面**没有用户名输入框、没有端口输入框、没有远端命令路径**，而预设又强制决定了传输方式。
  用户的 NAS sshd 在 **2222**，而表单只能发出 `ssh:{host}`，于是 ssh 用**本机用户名和 22 端口**去连，
  报 `banner exchange: Connection to UNKNOWN port -1: Connection refused`；
* 界面上那个唯一的"密码"框，在非 opencode 的传输下被写进了 **`token`** —— 而 ssh 路径**根本不读
  `token`**。于是密码**既明文落盘、又毫无用处**（用户真实的 `nodes.json` 里就躺着 `"token": "<口令明文>"`）；
* 失败时只剩 `process exited (code=255)`，**说不出原因**。用户当时能看到 `banner exchange`，
  是因为控制面把 ssh 的 stderr 当事件转发了出来；同样的错误在命令行复现时反而看不见。

这三条合起来的效果很坏：**节点看起来注册成功了、密码躺在磁盘上、探测失败还给不出理由**。
单测覆盖了修复后的形状，但覆盖不了"用户真正做的那个动作"。所以这一节有两层。

#### 3.9.2 单元/集成层：`test/web.test.js`，15 例

它用 `node:http` 起**真正的控制面服务**，用 `fetch` 按浏览器那套调用打它（不是直接调函数）：

| 覆盖点 | 断言的是什么 |
|---|---|
| 字段完整落盘 | 用户名、端口、远端命令全路径、工作目录都真的进了 `nodes.json`（缺陷 36） |
| **密码不落盘** | 对 `nodes.json` 的**原始字节**断言不含密码，也不含 `"sshPassword"` 键（缺陷 37） |
| **不回落 `token`** | 非 opencode 传输下密码不再被塞进 `token`（缺陷 37 的原始症状） |
| 不回显 | `GET /api/nodes` 的 JSON 里也没有密码 |
| 编辑只改给定字段 | 只改端口时，用户名与远端命令**不被弄丢**（缺陷 38） |
| 编辑失效缓存 | 改完配置后长驻服务不再用旧配置的缓存适配器（缺陷 38 的 `Fleet.invalidate()`） |
| 模型配置落盘边界 | `/api/agent/config` 只把**地址与模型**写进 `.agentmesh/llm.json`，密钥不落（缺陷 40） |

> 这一组的最后一条还顺带暴露了一个更隐蔽的问题：`Fleet.close()` **从不关 SQLite 句柄**，
> 退出后 `mesh.db` 仍被占用（缺陷 41）。发现它的方式是——**所有断言都通过了，却在校验清理时报 EPERM**。

#### 3.9.3 真机层：`tools/verify-console.mjs`，21/21

`test/web.test.js` 证明的是"形状对了"。用户真正做的动作是**点一下「探测」并拿回另一台机器上
真实 agent 的握手**，所以这个脚本用同一套 HTTP 调用打**真控制面**、连**真 NAS**：

```
$env:NAS_SSH_PW = '<密码>'        # 只进内存
node tools/verify-console.mjs --host 10.0.0.5 --port 2222 --user user
```

它**在 NAS 没配好时会大声跳过**——一个"什么都连不上却静默通过"的验证，比没有验证更糟。

21 项里最值得记的两条：

**① 探测拿回的是真实握手。** 用表单那套 body 注册（含用户名 / 2222 / 远端 `hermes-acp` 全路径 /
工作目录），再 `POST /api/nodes/:ref/probe`，拿回的是真实的 **ACP `hermes-agent` v1** 握手——
不是"HTTP 200 就算过"，而是真的完成了 ACP `initialize`。

**② 端口故意设成 22 时，错误本身会解释原因。** 这是把用户的原始症状**原样重放**：
NAS 在 22 端口上会接受 TCP 连接、然后**在 banner 交换中途断开**。修复前这种情况只能得到
`process exited (code=255)`；修复后（缺陷 39：acp 适配器保留 ssh stderr 尾部并拼进关闭原因）
错误里同时带着**两段**信息：

```
acp:… closed: process exited (code=255)
banner exchange: Connection to UNKNOWN port -1: Connection refused
```

一条告诉你"子进程怎么死的"，另一条告诉你"ssh 自己认为发生了什么"。这正是用户当时**在控制面上
看得到、在命令行里复现不出来**的那句话——现在两边都有了。

其余检查项覆盖：注册后端口/用户名/命令/BatchMode 都保住了、控制面报告"密码可用"及其来源、
密码不在 `nodes.json` 原始字节里、`GET /api/nodes` 不回显、`--ssh-password-env` 存的是**变量名**
而值不落盘、控制面能从环境变量解析出密码、`update` 只改端口而不丢用户名与命令、密码在编辑后仍在
内存里、`delete` 真的删掉、以及**删完之后注册表里不残留任何机密**。

#### 3.9.4 界面自检：`tools/check-ui.mjs` + `tools/check-ui.selftest.mjs`

控制台是**一个内联脚本的单页**，没有构建步骤，所以"改了 HTML 但写错了 id"这类错误
不会在编译期暴露，只会在浏览器里静默失灵。`check-ui.mjs` 做八条静态检查：

1. 内联脚本能否被 `new Function()` 编译；
2. 每个字面量 `$('id')` 是否都有对应的 `id="..."`；
3. 每个 `dataset.x` 读取是否真的有 `data-x` 产出；
4. **不允许用 DOM 位置切换布局**（`x.parentElement.style`）——这条规则是缺陷 44 的产物：
   真有一个这样的 bug 上过线，而且**只有浏览器能发现它**；
5. **每个控件都必须挂上自己的标签**（被 `<label>` 包住，或有 `<label for>` 指向它，
   或带 `aria-label`）——缺陷 51 的产物。placeholder **不算**标签：一填就消失；
   同时反向禁止"戴着 `<label>` 帽子的分组标题"（既没包控件也没有 `for`）；
6. **不允许行内 `style="…"`**——缺陷 51 的另一半。旧页面有 35 处行内样式，其中
   `style="flex:0 0 230px"` 与样式表里的 `.row > * { flex: 1 }` 互相打架，列宽因此毫无理由地不齐。
   报告行号分别按 markup 与 script 计算，且脚本部分先剥注释——注释里**描述**缺陷不算缺陷；
7. **手写的 class 名必须在样式表里有对应规则**（只查静态 class，跳过含 `${}` 的动态拼接）。
   拼错一个 class 会**完全静默**：元素只是渲染成没样式，没有任何其他检查看得见；
8. **结构体检**（没人能开浏览器，所以把浏览器会暴露的崩溃变成机械检查）：标签是否闭合
   （未闭合的 `<div>` 会吞掉它之后的一切）、id 是否重复（`getElementById` 只返回第一个，
   第二个就是死元素）、`<style>` 的括号是否平衡、是否恰好只有一个 `<style>` 与一个内联 `<script>`。

前七条都要求先**正确剥离注释**再扫描（否则"规则的解释文字"会被当成"违规"，
见缺陷 48——那件事的修复还一度静默失效，因为剥离器不认识正则字面量）。

当前输出（`npm run check:ui` 的第二步）：

```
  · inline script compiles (572 lines)
  · 63 literal element lookups, 64 declared ids
  · 10 dataset reads, 10 data-* attributes emitted
  · 28/28 controls carry a label or aria-label
  · markup nesting balanced, 63 unique ids, 1 style block
UI OK
```

**检查器自己也有自测**，这一点是刻意的：**抓不到问题的 lint 等于没有 lint**。
`tools/check-ui.selftest.mjs` 把一个已知坏掉的 `ui.html` **注入 9 种缺陷**（语法错误、查不存在的 id、
用 `parentElement` 切布局、读没人写的 `data-*`、页面里冒出第二个内联脚本、**控件没有标签**、
**分组标题冒充标签**、**元素上的行内样式**、**生成代码里的行内样式**），逐条断言检查器**必须报错**，
再断言真实的 `ui.html` 通过；**外加一条反向断言**——注释里描述缺陷**不得**被当成缺陷（缺陷 48）。
自测还有一个**防自欺的守卫**：任何一处"注入"如果没真的改动源文件（`String.replace` 静默返回原串），
直接抛错终止。这条守卫是被逼出来的——页面从 `style.display` 改成 `classList` 之后，
两个用例的目标字符串消失了，注入变成空操作，于是它们实际上是在拿一个**正确**的页面断言"检查器必须报错"：

```
  ✓ the real ui.html passes
  ✓ a syntax error in the inline script
  ✓ a lookup for an element id that does not exist
  ✓ a layout toggle driven by parentElement (the real browser-only bug)
  ✓ reading a data-* attribute nothing writes
  ✓ a second inline script appearing in the page
  ✓ a control with no label at all (the reported "I cannot tell which box is which")
  ✓ a caption wearing a <label> tag without being attached to a control
  ✓ an inline style on an element (the layout jumble)
  ✓ an inline style inside the generated markup
  ✓ a comment describing a defect is not reported as one

11 passed, 0 failed
```

`npm run check:ui` 把两步串起来（`node tools/check-ui.selftest.mjs && node tools/check-ui.mjs`），
所以检查器失效时它会先叫出来。

第 5/6/8 条是对着**旧版页面**验证过的：拿改版前的 `ui.html` 去跑，会报出 38 个问题，
其中就有那两条互相打架的 `flex:0 0 230px` / `flex:0 0 300px`——**规则在真实坏版本上有真阳性**，
不是写完就绿的摆设。

它**不能**替代在浏览器里看一眼（见第 5 节），但能挡住"id 拼错"、"用 DOM 位置做布局"、
"控件与标签失联"和"标签没闭合把整页排版带崩"这几类会让整块面板失效、
而你只在点它的时候才发现的问题。

---

## 4. 验证过程中发现并修复的真实缺陷

这些不是推演出来的清单，而是**被上述验证逐条抓出来的**（含每条的触发条件）：

| # | 缺陷 | 触发条件 | 后果 | 修复 |
|---|---|---|---|---|
| 1 | `permissionOutcome()` 少一层嵌套，返回 `{outcome:'selected',optionId}`，而 ACP 要求 `{outcome:{outcome:'selected',optionId}}` | 任何人工审批 | **每一次批准都被 agent 当成拒绝**（agent 判定 `response.outcome.outcome == "selected"` 取到的是字符串）。真实 Hermes 直接报"写入被 ACP 客户端的审批拒绝" | 按钉住的官方 schema 补上嵌套；测试改为钉住判别路径 |
| 2 | 审批 id 由 JSON-RPC 请求 id 派生（`appr_0`），而请求 id **每个进程都从同一基数重新开始** | 同一节点第二次需要审批 | 新审批与上一轮历史行主键冲突，被 `INSERT OR IGNORE` 静默吞掉 → 运维看到"没有待审批"，而 agent **永久阻塞** | 审批 id 改为全局唯一；`requestId` 仅作路由键；新增跨运行回归测试 |
| 3 | ACP 的回答以 `agent_message_chunk` 增量流式到达，但从未累加 | 任何 ACP 任务 | 任务记录（`mesh task`、Web 控制台、`--json`）**结果恒为空**，实时看得到、事后查不到 | Fleet 在 ACP 分支累加 chunk 作为任务结果 |
| 4 | `listApprovals` 默认 `status='pending'`，而 `--all` / `?status=all` 传的是 `undefined` | `mesh approvals --all`、控制台"全部" | 过滤条件静默失效，**已批准的记录查不到**，看起来像从未落库 | store 默认改为不过滤；CLI/HTTP 显式传 `null`；加测试 |
| 5 | opencode 用 `x-opencode-directory` 头发送工作目录 | 工作目录含非 ASCII（如 `D:\工作`） | HTTP 头只允许 latin1，`fetch` 直接抛 `Cannot convert argument to a ByteString`，**中文路径下适配器完全不可用** | 改用 `?directory=`（优先级更高且可百分号编码） |
| 6 | `eventsSince(opts)` 收选项对象，但传数字时不报错 | `eventsSince(5)` 这种"看起来对"的调用 | 静默变成 `after=0`，**返回整个日志**而非增量 | 同时接受数字简写；测试断言两种形式一致 |
| 7 | `JsonRpcPeer.request()` 把发送推迟到微任务，`notify()` 立即写 | 紧跟 `session/prompt` 的 `session/cancel` | 取消可能**先于**提示词到达 stdio 管道 | 改为同步写入，异步错误仍走 reject |
| 8 | 探测失败原因被 `catch {}` 吞掉 | 端点不可达 | `mesh probe` 只能说"不可达"，说不出为什么（#5 就是靠这一点才定位到的） | probe 返回 `errors` 明细和 `endpointsFound` |
| 9 | 控制面进程被杀后，被挂起的任务永远停在 `working` | 审批期间杀掉 `mesh serve` | 控制台/`mesh status` 永远谎报任务在跑 | 任务记录 `owner_pid`，启动时对账死亡进程的孤儿任务为 `failed(interrupted)`；含旧库迁移 |
| 10 | A2A artifact 分片未区分 `append`，且 `extractText` 对每个分片 `.trim()` | 流式 A2A 响应 | 分片语义错误、`"streamed "` 的尾随空格被吃掉导致分片粘连 | 按 `artifactId` + `append` 累积；分片提取关闭 trim |
| 11 | `mesh serve` 端口被上一轮遗留进程占用时静默连到旧进程 | 端口未释放 | **修复后的代码看起来仍然有 bug**（验证脚本连到了旧进程，浪费一轮排查） | `/healthz` 增加 `bootId`/`pid`/`startedAt`；验证脚本断言并打印 bootId |
| 12 | `parseArgs` 把「可重复 flag」排除在「消费下一个 token 作为值」之外 | `--env K=V`、`--tag x`、`--capability c`、`--node a` | 全部只拿到裸布尔 `true`，真正的值掉成位置参数。**`mesh broadcast "<p>" --node a --node b`（文档主推的扇出用法）会去找名为 `true` 的节点**；`--env` 则完全静默失效 | 可重复 flag 与普通 flag 一样取值；新增 `test/args.test.js`（11 例）钉住；`--node` 缺值时报明确错误；以 `-` 开头的值用 `--arg=--x` 形式 |
| 13 | `fleet.resolveTargets` 按**字符串**读取 `capability`，而 CLI 传来的是**数组** | `mesh broadcast --capability c` | `['c'].includes(['c'])` 恒为 false → **按能力扇出选中 0 个节点，还报成功** | 同时接受字符串与数组、多值取「任一匹配」；新增 `test/fleet.test.js`（5 例） |
| 14 | 适配器各自把事件直连 `onEvent`，而 Fleet 自己发的生命周期事件只进 `listeners` | 任何 `mesh send` | `--json` 流里**永远没有 `done`**（也没有 `task-created`/`task-state`），消费方无法判断任务何时结束、成败如何；`--approval ask` 的交互式提问也因此收不到事件 | 投递收敛到 `emit()` 一条路径（按 `taskId` 路由到该次 send 的 sink），并删除适配器里 13 处重复直连——**否则每个 chunk 会被累加两次、结果文本翻倍** |
| 15 | 走 SSH 时 `node.env` 被整体丢弃（`sshProcess` 根本不接受 env） | 节点上用 `--env` 配了模型/密钥等变量 | 环境变量静默消失，远端 agent 用错配置或直接鉴权失败 | env 通过 `exec env K=V …` 随远端命令送达（裸 `VAR=x` 前缀会绑到 `cd` 上，是错的）；有单测与 3.4 的实跑记录 |
| 16 | `sshExec` 把**整条命令串当成一个词**去 `shellQuote` | 任何带空格的一次性远端命令（`mesh node check`、SSH 上的 cli 传输探测） | 生成 `exec 'md5sum f; cat f'` —— 一个不可能存在的程序名，**远端一律 exit 127**；即"经 SSH 的 cli 节点探测从来没成功过" | 区分"程序+argv"与"已是 shell 行"两种输入：新增 `buildRawRemoteCommand`，并给 `sshProcess` 加 `remoteCommand` 覆盖口；有单测 |
| 17 | 一次性命令沿用了 agent 路径的 `exec` | 一次性命令含 `;` / `&&` / 管道 | `exec a; b` 会把 shell 替换成 `a`，**第一个分隔符之后的命令全部静默不执行**，而且看起来是成功的（实测 `md5sum f; cat f` 只输出 md5，`wc -c` 与 `cat` 从未运行） | 一次性命令改走 `sh -c`：`;`/`&&`/管道/重定向都成立，且 `cwd`/`env` 作用于整行而非只作用于第一条；有单测 |
| 18 | `sshExec` 把 `batchMode: true` 写死，无视 `target.batchMode` | 只接受密码的节点（按 `--ssh-batch-mode no` 注册） | 一次性远端命令在这类节点上**必定失败**，而同样的节点 `mesh send` 却正常——很难归因 | 改为 `target.batchMode !== false` |
| 19 | ACP `probe()` 会**毒化缓存里的适配器**：旧流的 `onExit` 回调去关 `this.#peer`，而那时 `#peer` 已经是下一次 `connect()` 新建的 | **同一进程内**先 `probe(node)` 再 `send(node)` | 旧进程的 SIGTERM 把**新连接**关掉，任务 `failed`、`sessionId=null`、连一条事件都没有。**这正好是 Web 控制台的行为**（先探测再派发），意味着控制台对刚探测过的节点**永远发不出任务** | 把处理器绑定到它所属的那条连接（捕获 `stream`/`peer` 局部量），并加"这条流已不是当前流就直接返回"的守卫；新增 `test/acp-lifecycle.test.js` 用**真实子进程**钉住——手写假适配器表达不了这一类缺陷 |
| 20 | `--ssh-opt` 与 `--ssh-binary-arg` 没被登记进 `REPEATABLE` | 这两个 flag 出现两次（如同时传 `UserKnownHostsFile` 与 `StrictHostKeyChecking`） | 第二次**覆盖**第一次，`UserKnownHostsFile` 被丢掉，ssh 转头去写 `~/.ssh`（在受限环境下直接失败） | 补进 `REPEATABLE`；新增测试断言三个 `-o` 全部保留、顺序不变 |
| 21 | 可重复 flag 缺值时**静默存成布尔 `true`**，真正的值掉成位置参数 | `--node --json`、`--ssh-binary-arg -batch`（值以 `-` 开头） | 与第 12 条同源：扇出会去找名为 `true` 的节点；`-batch` 这类 plink 参数被吞掉且毫无提示 | 缺值直接**报错退出 2** 并提示 `--flag=<value>` 写法（`--ssh-binary-arg=-batch`）；`parseArgs` 抛错、`main` 捕获为用法错误而非崩溃栈 |
| 22 | CLI 层无法表达节点上已经支持的两种 SSH 认证/连接配置（`ssh.extraOptions`、`ssh.batchMode`） | 密码型主机、需要 `ProxyJump` / 自定义 `known_hosts` 的主机 | 只能手改 `nodes.json`；而 Bash 型包装 ssh（`.cmd`）又必须被拒（第 3.5 节），用户没有可用出口 | 新增 `--ssh-opt <o>`（可重复，原样透传 `-o`）与 `--ssh-batch-mode yes|no`；有单测与 3.6 的真机实跑 |
| 23 | `mesh cancel` 在没有活动连接时**谎报成功**：它新建一个从未连接过的 Fleet，而 `adapter.cancel()` 因实现是 `this.#peer?.notify(...)` 成为**静默空操作**，代码却照样把记录改成 `canceled`、打印 `✓ canceled`、退出码 0 | 在**另一个进程**里取消正在运行的任务（终端 B；或根本没有 `mesh serve` 在跑） | 运维以为已经叫停，**远端 agent 仍在干活**，而 `mesh tasks`/`mesh status`/控制台全都显示 `canceled`——"看起来成功、实际什么也没做"，与第 19 条同类 | 改成先问**持有连接的那个进程**（`POST /api/cancel`，与 `mesh approve` 完全同一设计）；没有就**明确拒绝**并保持记录不变（不再写库）；`test/cli-cancel.test.js` 用真实子进程 + 桩服务器钉住 5 种情形 |
| 24 | HTTP 层的失败被原样抛出，`fetch` 的**真正原因藏在 `err.cause` 里**，运维只看到 `TypeError: fetch failed` | 任何 A2A / opencode / HTTP 端点不可达 | **无法归因**：`ECONNREFUSED`（主机回答了，只是没人监听）与 `ETIMEDOUT`（中间有防火墙在丢包）需要**完全不同的处置**，但两者打印出来一模一样。这正是用户那个真实公网 A2A 端点排查时卡住的地方，而第 8 条当初只修了 opencode 那条路 | 新增 `describeFetchError()`：展开 `cause`，把 `ECONNREFUSED`/`ETIMEDOUT`/`UND_ERR_CONNECT_TIMEOUT`/`ENOTFOUND` 等翻成可执行结论（并点明"超时=丢包，而已关闭的端口会是被拒绝"）；`postJson`/`getJson`/`getText`/`streamSse` 四条路径统一使用；`test/http.test.js` 13 例钉住 |
| 25 | 节点的 `kind` 标签硬编码兜底成 `'generic-acp'`，与 transport 无关 | `mesh node add --transport a2a`（不给 `--kind`） | `mesh node list` 与控制台显示 `generic-a2a` 节点为 **`generic-acp/a2a`** —— 一个既不对应预设也不对应传输的标签，误导人以为它是个 ACP 节点 | 兜底改为 `` `generic-${transport}` ``（acp 仍然是 `generic-acp`，行为不变）；有实跑对照 |
| 26 | A2A 客户端**盲从卡片里宣告的 RPC 地址**，即使那是个从外面根本不可达的私网地址 | 被管 agent 在 NAT/云 VPC 之后，卡片里报的是它自己的内网地址（实测：`http://172.24.225.207:9900/`）；而卡片本身是从公网地址取回来的 | **每一个任务都发往一个不可路由的地址**，超时。更糟的是这个超时**看起来完全像防火墙问题**（`UND_ERR_CONNECT_TIMEOUT`），运维会去错误的方向排查——而真正的原因是服务端把自己地址写错了。`mesh probe` 还显示"reachable"，因为卡片确实取到了 | 新增 `isPrivateHost()`（RFC1918 / 回环 / 链路本地 / CGNAT / 组播 / IPv6 ULA 等）；当卡片宣告的是**私网地址且与卡片来源主机不同**时，保留卡片给出的路径、换成**已被证实可达的来源 origin**，并明确告警；`mesh probe` 会把这条告警打出来；有真实端点实跑对照 |
| 27 | A2A 客户端**永远只用 v1.0 的方法名**（`SendMessage` / `SendStreamingMessage`），不看卡片宣告的协议版本，也没有回退 | v0.3 形状的对端（卡片没有 `supportedInterfaces`，只实现 `message/send`） | 对端返回 `-32601 Method not found: SendMessage`，任务直接失败——而**这个对端是完全能用的**，只是话术不同。真实的 Hermes v0.14 A2A 桥就是这个形状 | 新增 `prefersLegacyMethods()`：按卡片宣告的版本（含 `supportedInterfaces[].protocolVersion`）在 v1.0 / v0.3 两套方法名之间选择；并在收到 `-32601` 时**自动换另一套方法名重试一次**（`isMethodNotFound()`），因为卡片也会说谎。`getTask`/`cancel` 同样处理 |
| 28 | `--continue` 只复用 `contextId`，**默认不夹带任何历史**；而对端不维护服务端上下文时，每一轮都是孤立问答 | 对端接受并回传 `contextId`、每次都新建 task，但构 prompt 时只用最新那条消息（实测的真实第三方对端就是这样） | **"看起来是对话，其实不是"**：三轮"对话"里第二轮它又自我介绍了一遍，第三轮它直接说"此前轮次未进入我的会话上下文"，于是让它"把我们这次对话存下来"存出来的只有最后一轮。客户端全程**没有任何提示**，用户以为上下文保持了——与被修掉的第 19、23 条同类：**表面成功、实质没做** | 新增 `--with-history`（`replayHistory`）：续接时由**客户端**从本地库里重建该 `contextId` 的既往轮次（`Store.historyForContext`），折叠成 `<earlier conversation>` 转录后随本次消息送出（`withConversationHistory`）。**默认关闭**——对真正维护上下文的对端重复喂料是有害的，所以它必须是显式选择，而不是偷偷替对端做主。验证方式见 3.7.3：加上它之后对端能通过记忆测试，之前不能 |
| 29 | `parseArgs` 的「不取值开关」名单 `BOOLEAN` 是**手工维护**的，新增的 `--dry-run` / `--read-only` / `--confirm` 没登记进去 | `mesh agent --confirm 让 nas 干活`（开关写在**句子前面**，这是最自然的写法） | 解析器按"取值开关"处理，**吞掉了句子的第一个词**：`confirm` 拿到 `"让"`，提示词被悄悄改成 `"nas 干活"`；`--dry-run <句子>` 更彻底——整个句子被当成 `dry-run` 的值，提示词**变成空串**，于是命令转去开交互式会话。用户完全看不出来，agent 会去执行一句他从没说过的话 | 补齐 `BOOLEAN`；并把这条规则写进该常量的注释（**任何新的布尔开关都必须登记**）；`test/args.test.js` 新增两例遍历所有开关，断言"开关不吞提示词、且顺序无关" |
| 30 | 新加的 `--allow <tools>` 与 `mesh approve` 已有的布尔开关 `--allow` **撞名** | `mesh agent "干活" --tools …` 之前写作 `--allow list_nodes,send_task` | 因为 `--allow` 在 `BOOLEAN` 里，工具清单**掉成位置参数混进提示词**（模型会收到 `list_nodes,send_task 干活` 这样的怪句子），同时**权限闸门静默不生效**——传了等于没传，而且不会有任何报错 | 改名为 `--tools`（`--allow` 留给 `mesh approve`，见第 29 条它不能取值）；未知工具名**报错退出 1** 并列出全部合法工具；新增测试钉住"`--tools` 取值、`--allow` 仍是无值开关" |
| 31 | `countDispatch()` **先自增再判断上限** | 一次运行里模型尝试派发次数超过 `maxDispatches` | 上限本身拦得住（实际派发数正确），但**计数把每一次被拒绝的尝试都算成一次派发**：`maxDispatches=2` 时返回值与 `agent-final` 事件里的 `dispatches` 会报 6。因为循环把 `countDispatch` 抛出的错误当数据喂回模型后继续跑，计数器会一路攀升。CLI 汇总行/控制台因此**虚报工作量**，且"上限被遵守"这类断言会失败 | 改为先判断 `dispatchCount + 1 > maxDispatches` 再自增；注释写明"先把计数加上再拒绝，会报告从未发生的派发" |
| 32 | `get_task` 工具直接调用 `Store.getTask(id)`，而它在任务不存在时**抛异常**（`unknown task <id>`） | 模型查询一个拼错/不存在的任务 id（很常见，它会凭猜测追问） | 工具层没有兜住这个异常，**整次运行被一个可纠正的输入错误打断**，用户拿到的是崩溃栈而不是"没有这个任务"。与"工具失败要作为**数据**喂回模型让它自行纠正"的设计直接冲突 | `get_task` 改为先 `findTask` 再在 try/catch 里退回 `getTask`，不存在时返回 `{error: "no task '<id>'"}`；新增测试断言它返回数据、不抛 |
| 33 | 编排器读节点能力用的是 `n.caps`，而注册表里的字段名是 `n.capabilities` | 任何一次运行（系统提示里要列出各节点能力） | 取到 `undefined`，**系统提示里的能力信息恒为空**，模型只能靠节点名字猜该派给谁——"让 NAS 写函数"这类路由因此更多依赖运气而非信息。这类缺陷不会报错，只会让路由悄悄变差 | 4 处全部改为 `capabilities`；`verify-agent.mjs` 新增一条断言，检查系统提示里确实带着真实节点名与能力说明 |
| 34 | **（测试基建）** 假 HTTP 服务端只用 `server.close()` 收尾，而 `fetch()`（undici）的连接池会保持 keep-alive 长连接 | 运行 `test/llm.test.js` / `test/orchestrator.test.js` | `close()` 会一直等这些**永远不会自己结束**的连接，进程挂住；此前的权宜之计 `--test-force-exit` 在 Windows 上会崩在 libuv 断言（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，`src/win/async.c:94`），**退出码 `0xC0000409`，而全部用例其实是通过的**——很容易被误读成测试失败 | 收尾改为先 `closeAllConnections()` 销毁连接再 `await close()`；两个文件从此**自己干净退出**，`--test-force-exit` 彻底不再需要（该 flag 单独使用时本就是空操作，只是掩盖了问题） |
| 35 | **（验证工具）** `verify-agent.mjs` 把工具返回值**按工具名**索引（后一次覆盖前一次） | 一次运行里同一个工具被调用两次——"先失败、再自我纠正"正是脚本要验证的核心场景 | 断言静默地检查了**第二次（成功）**的结果，而它要验证的**第一次失败**被覆盖掉了：检查"错误话术是否正确"的那条永远失败，看起来像产品缺陷，实为验证脚本自身在说谎 | 改为收集**有序的结果列表**并按谓词匹配（`anyOutcome(config, tool, re)`）；`test/orchestrator.test.js` 里早先也踩过同一个坑，用 `toolResult(llm,id)` 按调用 id 扫描修掉 |
| 36 | Web 控制面的「注册节点」表单**无法表达一个可用的 SSH 节点**：只有 5 个输入框（预设 / 名称 / 目标 / token 密码 / 工作目录），**没有用户名、没有端口、没有远端命令路径**，而且**预设强制决定传输方式** | 用界面注册一台 sshd 不在 22 端口、用户名也不同于本机账号的主机（用户的 NAS：sshd 在 2222、用户 `user`） | 表单只能发出 `ssh:{host}`，于是 ssh 拿**本机用户名 + 22 端口**去连，报 `banner exchange: Connection to UNKNOWN port -1: Connection refused`。**节点看起来注册成功了**，但探测永远失败，而失败信息指向的是"端口/网络"，不是"表单缺字段"——用户会去查防火墙。等于说：**这个界面按设计就注册不出用户唯一想用的那类节点** | 表单按传输方式自适应：主机 / 用户名 / SSH 端口 / 远端命令全路径 / 工作目录 / 认证方式（密钥或密码）/ 高级（审批策略、私钥、额外 `ssh -o`、节点环境变量、token）。字段完整落盘由 `test/web.test.js` 钉住，真机注册+探测由 `verify-console.mjs` 覆盖（3.9.3） |
| 37 | 控制面把 SSH 密码**写进 `token`**：`if (body.transport === 'opencode') body.password = secret; else body.token = secret;`。而 ssh 路径**完全不读 `token`** | 通过界面给一个 acp+ssh 节点填密码 | **密码既明文落盘、又毫无用处**：用户真实的 `nodes.json` 里留下了 `"token": "<口令明文>"`（真实登录口令，明文），而 ssh 连接根本不看它，于是节点仍然连不上。这是最糟的一种组合——**泄露了机密，却没换来功能** | `registry.js` 新增 `quarantineSecrets()`：`sshPassword` / `ssh.password` / ssh 节点上的 `password` **一律转移到内存侧表 `#secrets`**，落盘的那份被剥离；新增 `--unset` 用于清掉已经写进去的那份（这也逼出了缺陷 42/43）。`test/web.test.js` 对 `nodes.json` 的**原始字节**断言不含密码、也不含 `"sshPassword"`；`fleet.test.js` 钉住三种写法都被隔离、而 opencode 的 `password` 仍照旧落盘（**隔离是有边界的，不是一刀切**） |
| 38 | `mesh node` 与 Web 界面**都没有编辑功能**（CLI 子命令只有 add/list/show/remove/check，界面只有探测/删除），改一个字段只能**删掉重建** | 想给已注册的节点补一个端口或改一个工作目录 | 删掉重建会**丢掉节点 id**，而 id 是任务、事件、审批记录的外键——历史记录要么被一起删掉、要么变成孤儿。"改一个字段"这种最普通的运维动作，代价是丢历史 | `Registry.update()` 其实早就存在，只是没人接出来：新增 CLI `mesh node edit`、`POST /api/nodes/:ref/update`、界面「编辑」按钮（只改你传的字段，并打印**字段级 diff**）；另外新增 `Fleet.invalidate()`——否则长驻的 `mesh serve` 里改了配置**仍在用缓存适配器的旧配置**，表现为"改了没生效"。`test/web.test.js` 断言只改端口不丢用户名/命令、且缓存被失效 |
| 39 | `mesh probe` **丢弃 ssh 的 stderr**，失败只剩 `process exited (code=255)` | 任何 ssh 层面的失败（端口不对、banner 中途断开、认证被拒） | **说不出原因**。用户当时能看到 `banner exchange: Connection to UNKNOWN port -1: Connection refused`，是因为控制面把 ssh 的 stderr 当事件转发了出来；**同样的错误在命令行复现时反而什么都看不到**——最该有信息的地方（命令行）信息最少。这直接拖长了排查：`code=255` 既可能是端口错、也可能是认证错或 banner 不兼容 | acp 适配器**保留 stderr 尾部**（滚动保留最后若干行）并拼进关闭原因，于是错误同时给出"子进程怎么死的"与"ssh 自己认为发生了什么"。`verify-console.mjs` 把端口故意设成 22（NAS 会在 banner 交换中途断开，正是用户的原始症状）来钉住这条输出 |
| 40 | `setLlmConfig({apiKey})` 会**整体屏蔽** `baseUrl`/`model`——因为 `llmConfig()` 一旦发现存在 override 就**整体返回它** | 在控制面「编排 Agent 的模型」面板里**只填一个 API 密钥** | 填密钥这个动作**反而把已经配好的地址和模型抹掉了**：界面立刻变成"未配置"，编排 Agent 再也跑不起来。用户的主观感受是"填了密钥就坏了"，而归因方向完全错误（会去怀疑网关或密钥本身） | 新增 `applyLlmRuntime()`：**先解析出当前生效的配置，再在它之上叠加补丁**，而不是用一个残缺对象整体替换。`/api/agent/config` 改用它，于是"只提交密钥"不再清空端点（缺陷 40 的注释就写在调用点上）。`test/web.test.js` 钉住"只把地址与模型落盘、密钥不落"。**边界要说清：受这条影响的只有控制面**——CLI 走的是 `AGENTMESH_LLM_*` 环境变量 + `.agentmesh/llm.json` 文件回退，不经过那条 override 路径，所以命令行一直是正确的（收尾时顺手删掉了 `main.js` 里一个导入但未使用的 `setLlmConfig`，这与本缺陷相关但不是成因） |
| 41 | `Fleet.close()` **从不关闭 SQLite 句柄**，`mesh.db` 在进程退出后仍被占用 | 退出后立刻删除该数据库所在的目录（Windows 上会失败） | 是一次**验证工具自己被卡住**才暴露的：`test/web.test.js` 的**全部断言都通过**，却在校验清理时报 `EPERM`。这类"功能全对、清理报错"的现象很容易被当成测试环境噪声而忽略过去，但它实际是资源泄漏——长时间反复起停控制面会积累句柄 | 新增 `Store.close()`，并由 `Fleet.close()` 调用（`store.js` 里两处 `#db.close()` 收敛到这个方法）。测试的 `after()` 现在是干净的，也不再需要任何强制退出手段 |
| 42 | **值型参数缺值时被解析成布尔 `true`**；经 PowerShell 传递 `--token ""` 时**空字符串被丢弃**，于是 `--token` 后面直接跟上 `--ssh-user` | `mesh node edit nas --token "" --ssh-user user`（用户想清掉那个泄露的密码，这是当时唯一看起来可行的写法） | `--token` 拿不到值 → 变成 `true` → **`token: true` 被静默写进了用户的真实注册表**。用户的本意是"删掉这个字段"，结果反而**新增了一个垃圾字段**，而且没有任何报错。这是本项目里反复出现的那一类：**看起来成功、实际做反了** | 新增校验：**非开关型 flag** 拿到 `true` 时**拒绝并提示改用 `--unset`**（第一版实现本身写错了，见第 45 条）。`test/args.test.js` 钉住"值型参数缺值会变成 `true`"这个机制本身（即缺陷的成因），并断言**不存在可以携带 SSH 密码本身的命令行参数** |
| 43 | 注册表**无法删除字段**（合并语义只能增改） | 用户要清掉缺陷 37 留下的那个泄露密码 | 唯一的出路是 `--token ""`，而那**正好触发缺陷 42**——两个缺陷叠在一起，用户根本没有正确的办法把一个已经落盘的机密清掉。也就是说：**泄露容易，撤回没有路** | `Registry.update()` 支持 `unset: [...]`（含 `ssh.user` 这类**点号路径**），CLI 暴露 `--unset <field>`（**可重复**，已登记进 `REPEATABLE`——否则传两次只保留最后一个，又是同一类静默错误）。`fleet.test.js` 钉住 `update()` 能合并 `ssh` 且 `unset` 真能删字段；`args.test.js` 钉住 `--unset` 可重复且不落成位置参数 |
| 44 | `ui.html` 用 `$('a-url').parentElement.style.display` 来**隐藏字段**，而 `a-url` / `a-command` 的父节点是**整个表单容器** | 在控制面上**切换传输方式**（比如从 `a2a` 切到 `acp`）——也就是注册任何一个节点时的第一个动作 | **"隐藏 URL 字段"把整个「注册节点」表单隐藏掉了**：切一次传输方式，表单连同所有输入框一起消失，用户**再也注册不了任何节点**，而且**没有任何报错**。它只在浏览器里才暴露，而本项目当时**没有任何非浏览器检查**能发现这类问题——所有接口都是对的、所有单测都是绿的，坏的只是 DOM 结构 | 改为两个显式容器 `#a-http-fields` / `#a-ssh-fields`（给容器自己的 id，而不是从输入框往上走）。`tools/check-ui.mjs` 的**第 4 条规则**（禁止用 `parentElement.style` 做布局开关）就是由它而来，并且 `check-ui.selftest.mjs` 里有一条专门注入这个缺陷、断言检查器必须报出来 |
| 45 | **缺陷 42 的兜底校验写错了对象**：它检查的是**构造好的 payload**（"字符串字段不得为 `true`"），于是**误杀了 `--local`、`--shell` 这类真正合法的布尔开关** | 任何使用 `--local` 的命令，即"注册一个本机节点"这种**最常见的用法**：`mesh node add x --kind hermes --local` 直接报 ``--local` needs a value` | 修一个"拒绝垃圾输入"的校验，**顺手把最常见的合法用法也拒了**——修 A 坏 B，而且坏的是主路径。同一处还暴露了第二个更隐蔽的问题：那个强制转换会**静默改坏数字**，`int(true, 22)` 得到的是 **`1`**（因为 `Number(true) === 1`），所以缺值的 `--ssh-port` 会变成**端口 1** 而不是报错。端口变成 1 比报错难查得多：它看起来是个"配置值"，会把你引向网络排查 | 改为检查**原始 flags** 而不是 payload：`valuelessFlags(flags)` 由 `src/cli/args.js` **导出**（纯函数，单测可直接覆盖），并维护 `VALUELESS_OK` 白名单——`--local` / `--shell` / `--client-fs` / `--client-terminal` / `--enabled` / `--ssh-clear-secret` 加全局开关。判据是**按 flag 名**，而不是按字段类型。`--ssh-port` 缺值现在会报错，不再变成 1。`test/args.test.js` 有一例回归测试专门断言 `--local` / `--shell` 不得被误报 |
| 46 | **测试用的假服务器被 OS 分配到一个 `fetch()` 按规范拒绝连接的端口**：`server.listen(0)` 让内核随便挑空闲端口，而其中一部分在 WHATWG fetch 的**禁止端口列表**里（`sane-port` 6566、X11 6000、IRC 6667 等，共 82 个），`fetch()` 会直接拒绝，报 `fetch failed (bad port)` | `test/orchestrator.test.js` 的「the dispatch limit stops a runaway fan-out」——**24 次全量运行里失败 1 次**：`Error: cannot reach http://127.0.0.1:6566/v1/chat/completions: fetch failed (bad port)`。端口本身是**好的**（curl 能连），是 fetch 按规范不连 | **失败的测试与被测代码毫无关系**，而且它**偶发**。偶发比硬失败更糟：它会训练所有人"重跑一遍、忽略红色"，而那正是这个项目最不愿养成的习惯。根因定位过程本身也说明问题：单跑该文件 3 次全过（看起来是环境相关）→ 密集循环 30 次复现 1 次 → **把完整输出落盘才看到真正的错误是 `bad port` 而不是断言失败**（只看"第几个断言挂了"会一路查错方向）→ 再用脚本**实测** 6566/6667/6000/4045/10080/5060/1/22/25/4190 全部 `bad port`，而 7331/2222/49152/51234 可连——**列表是实测出来的，不是凭记忆抄的** | 新增 `src/core/transport/net.js`，导出 `BLOCKED_FETCH_PORTS` / `isBlockedFetchPort()` / `listenOnFetchablePort(server, host, attempts, isBlocked)`：监听 0 端口，若拿到的端口在禁止列表里就**关掉重掷**（默认 12 次）。接入 **13 处**：`test/cli-cancel`(3)、`a2a-adapter`(2)、`orchestrator`(2)、`opencode-adapter`(1)、`llm`(1)、`tools/verify-agent`(2)，以及 **`src/web/server.js`（`port === 0` 时）**——所以 `test/web.test.js` 与 `tools/verify-console.mjs` 也一并被覆盖。验证：修复前 24 次全量失败 1 次；修复后 `orchestrator.test.js` **连续 60 次全过**、全量**连续 6 次全过**。`test/net.test.js` 4 例钉住它（含"硬编码列表与当前 Node 的实际行为仍一致"），列表的一致性由第 ② 条长期守住，见第 5 节 |
| 47 | 控制面**编辑节点时无条件提交预设下拉框的值**。A2A 节点的 `kind` 是 `generic-a2a`，而预设列表里只有 `generic-acp` / `hermes` / `opencode` / `gemini` / `claude` / `codex`，`select.value = 'generic-a2a'` 会**静默落空**（select 保持第一项） | 在控制面上**编辑一个 A2A 节点**，哪怕只是改一个端口 | **"只改一个端口"会把节点的产品标签从 `generic-a2a` 改成 `hermes`**。没有任何报错——因为 `kind` 在这份代码里是**纯展示字段**（`registry.js` 里写明没有任何功能读它），所以功能不受影响、测试也不会红；但界面从此**显示错误的产品名**，而用户正是按标签理解"这台机器上跑的是什么"的。它与 44 同源：**都只在浏览器里才犯，而且都是静默的** | 既然 `kind` 只是展示用，就**只在新建时提交**；编辑时若该 kind 不在预设列表里，界面会明确写出「此节点的产品标签是 X，不在预设列表里——编辑不会改动它」。`test/web.test.js` 钉住契约：**update 里没提 `kind` 就必须原样保留**。这条与 44、45 一起构成同一课：**"界面显示的东西"也是契约的一部分**，哪怕没有任何代码读它 |
| 48 | **（验证工具）** `tools/check-ui.mjs` **在注释里也扫描代码模式**，于是"说明性文字"被当成"违规代码"：把「不要这样写：`$('a-url').parentElement.style`」这句解释写进 `ui.html` 的注释后，**检查器在完全正确的文件上报了失败**；同理注释里一句 `talking to an agent (` 被当成"调用了未声明的函数" | 任何一次往 `ui.html` 的注释里写示例代码——也就是**给代码加说明**这个最正常的动作 | 一个**会对自己文档撒谎的检查器**：它惩罚的是"把规则解释清楚"这种行为本身，而唯一的"修复"方式是把注释删掉、让规则重新变成口口相传的隐性知识。更值得记的是它的修复过程：**第一步（剥离注释）静默失效了**——剥离器不认识**正则字面量**，`ui.html` 里 `/[&<>"]/g` 中那个 `"` 被当成字符串开头，扫描器状态从此错乱，**后面所有注释都没被剥掉**。"改好了但没生效"比原缺陷更难查：它看起来完全像是别的原因 | 给剥离器加**正则字面量识别**（按前一个有效字符判断这是正则还是除号）；并新增自测用例「**注释里描述缺陷不得被当成缺陷**」，把这条契约钉死。于是 `npm run check:ui` 的自测从 6 条变 **7 条**，输出 `7 passed, 0 failed` 然后 `UI OK`。这条和第 34/35 条同类——**验证工具的缺陷优先级不低于产品缺陷**，因为它决定了你信不信其他所有结果 |
| 49 | **`askpassChildEnv()` 完全没有单测**——它是 SSH 密码到达 ssh 子进程的**唯一通道**（`sshProcess` 把它放进子进程环境，`tools/ssh-askpass.mjs` 再把 `MESH_ASKPASS_SECRET` 转交给 askpass 助手）。同时发现 `Registry.runtimeNode()` 的文档写着"总是返回副本"，但节点**没有**密码时它其实直接返回注册表里的**活对象** | 前者是"哪天它不再返回那个变量"，后者是"适配器拿到活对象后改一下手上的配置" | 前者属于**静默降级**：一旦这个函数不再返回变量，密码认证只会退化成"提示没有东西可回答"（就是 `--ssh-password-env` 那条告警），**没有任何别的症状**——功能看起来只是"那台机器用密码连不上"，而这类问题最该被测试钉住。后者是**污染**：适配器改一下手上的配置就会改到注册表条目，并**可能被下一次 `save()` 落盘**——也就是说一个只读的"拿一份运行时配置"动作，能悄悄改写持久化状态 | 为通道补两条单测：① `askpassChildEnv` 在有密码时返回 `{MESH_ASKPASS_SECRET: ...}`、无密码时返回 **`{}`**（**不能**是 `{MESH_ASKPASS_SECRET: undefined}`，那会把字符串 `"undefined"` 塞进子进程环境），同时断言 `tools/ssh-askpass.mjs` 真的读这个名字、且设置了 `SSH_ASKPASS_REQUIRE`；② **密码绝不出现在 argv 或远程命令行里**——argv 是本机任何进程都能通过 `ps` 读到的，这正是密码会泄漏的路径，断言 `buildSshArgs()` 的每个参数都不含密码、也不含 askpass 相关字样（该机制必须是**环境变量驱动而非命令行驱动**）。`runtimeNode()` 改为**无条件浅拷贝**（`{...node, ssh: {...node.ssh}}`），`test/fleet.test.js` 里那条现在断言"改副本不会到达注册表"。**这两处合起来是同一课：一个私有通道和一个"只读"访问器，都属于"没有测试就一直没人看"的地方** |
| 50 | **`mesh node add ... --ssh-password-env NAS_SSH_PW` 记下了密码来源，却没有关掉 `BatchMode=yes`**——而 ssh 在 BatchMode 下**拒绝使用密码**。于是这个节点被配置了一份**它永远花不出去的凭据**，失败时只会说"提示没有东西可回答它"。**控制面（Web）是会关掉 BatchMode 的，命令行不会**：同一个节点在界面里建就能用、在命令行里建就不能用 | 按文档写的方式建一个用密码认证的节点：用户当时正是在问「你看一下命令行里边是不是也是这样对应的」，也就是一个"文档、界面、命令行三者是否说同一件事"的问题 | 这是**同一件事在两条入口上答案不同**——本项目最反复出现的一类缺陷。它尤其值得记，因为它**产生了一条看起来完全正确的错误信息**：CLI 打印 `ssh auth: key/agent only (BatchMode=yes)`，这句话本身没错，错的是"节点本不该是 BatchMode=yes"。也就是说**错误的提示语会把你的注意力引到提示语本身上，而不是引到配置上**。它还说明"文档与实现一致"不等于"两条入口彼此一致"：文档如实描述了命令行行为，而命令行行为本身就是错的 | `nodeInputFromFlags` 在记录 `passwordEnv` 时把 `batchMode` 设为 `false`，**显式的 `--ssh-batch-mode` 仍然优先**（用户明说就听用户的）；没指定 `passwordEnv` 时**不凭空造 `batchMode` 的值**。修复后同一条命令打印的是 `ssh.batchMode is 'no' but no password is available`，并明确**指出该设哪个环境变量**——从"看着像对的错误提示"变成"能直接照着做的话"。`nodeInputFromFlags` 因此从 `main.js` **导出**（`bin/mesh.js` 才是调用 `main()` 的地方，导入该模块不会执行 CLI），`test/args.test.js` 用三例钉住映射：关 BatchMode、只改真正传进来的字段、密码环境变量的**名字**绝不变成命令行上的值 |
| 51 | **控制面「注册节点」表单的排版崩了，用户的原话是「我完全不知道每个框对应的是哪一个框了，已经分不清了」**。四个成因叠在一起：① **完全没有分组**（整页 `<fieldset>` 数量是 **0**）；② 标签写成**整句话**，还用 `font-size:11px` + 灰色 + `text-transform:uppercase` + `letter-spacing` 渲染，例如 `<label for="a-secret">密码 —— 只存在服务进程内存里，不写进任何文件</label>`，于是"标签"和"说明"是同一串文字；③ **35 处行内样式与样式表互相打架**——`.row > * { flex: 1 }` 说"等分宽度"，`style="flex:0 0 230px"` 说"就 230px"，同一行里还有 300px、120px、110px、auto，列宽因此毫无理由地参差；④ **`init()` 从不调用 `syncNodeForm()`**，而 `a-http-fields` / `a-ssh-fields` 的初始隐藏状态只由那段函数写入，所以**首次加载时 URL 输入框和整套 SSH 输入框同时显示**，无从判断哪几个才适用于当前传输方式 | 第一次打开控制台——也就是用户做的**唯一一件事**。他明确说"内容我还没有看，功能我也没有测试，主要是它排版之后…已经分不清了"，所以这不是"用久了觉得乱"，而是**在读懂页面之前就被挡住了** | 这一条的价值在于它**推翻了本项目的一个隐含假设**：以往每个缺陷都是"行为错了"，可以用断言描述；而这一条里**所有接口都是对的、所有单测都是绿的、所有 id 都在**，坏的只有"人能不能看懂"。它还顺带暴露了检查器的盲区——`check-ui.mjs` 当时只查"id 有没有拼错"这类**引用正确性**，对"控件与标签的**视觉**归属"完全没有表达能力。最要紧的一点：**旧版的语义关联其实是正确的**（25 个 `label for=` + 3 个用 `<label>` 包裹的复选框 = 28/28 全都有标签），所以"加一条必须有标签的规则"**本来并不能抓到这次的问题**——写检查器时很容易在这里自我欺骗，以为加了规则就等于覆盖了缺陷 | 重写 `ui.html` 的样式表与结构：① 表单拆成 4 个 `<fieldset>` + `<legend>`（**它是什么 / HTTP 端点 / SSH 连接 / 高级选项**）再加一个可折叠的模型设置；② 每个控件放进 `.field` 这个**原子单元**（标签在上、说明在下，`<span class="sub">` 用 12.5px 小字而**不再大写**），标签从整句话缩成 2–6 个字，说明移出标签；③ 行内样式**全部删除**（35 → **0**），改成显式 4 列网格 `.fields` + `.span2/3/4`，落成固定列宽因而可预测；④ UI 字体从等宽改为系统无衬线，等宽只留给日志/表格/输入值；⑤ 加 `:focus-within` —— **哪个框获得焦点，它自己的标签就变色**，这是二十个字段同屏时最有效的一条"这个标签是你的"提示；⑥ 主题改为跟随系统的 `prefers-color-scheme`（所有颜色都走 CSS 变量，不留硬编码色以免只改一半）。JS 只改 7 处：显隐从 `element.style.display` 改为 `classList.toggle('is-hidden')`（表现归样式表），并在 `init()` 里补一次 `syncNodeForm()`（顺带修好成因 ④）。**验证方式**：新增 4 条静态规则（标签归属、禁止行内样式、静态 class 必须在样式表里有规则、标签闭合/id 重复/括号平衡），自测从 7 条加到 **11 条**；另在 `test/web.test.js` 里新增一例**打真实 HTTP 拿到的字节**上做同样的断言——因为 `createConsole` 在启动时就把 `ui.html` 读进内存，**改完文件不重启控制台，发的还是旧页面** |
| 52 | **新增的 `test/net.test.js` 里把 `7331` 和 `2222` 当作"可连接的端口样本"硬编码了**——而 `7331` 正是**本程序控制台的默认端口**，`2222` 是测试 NAS 的 ssh 端口。于是只要有一个控制台在跑，全量测试就必然以 `EADDRINUSE: address already in use 127.0.0.1:7331` 死在 `test/net.test.js`，**后续 10 个测试文件一个都不会执行**（`&&` 链断在这里）。用户当时**正开着控制台在看这个页面**，所以第一次跑就复现了 | 在控制台运行时执行 `npm test`——也就是**开发控制面时的常态** | 这是"测试与环境抢资源"的典型：测试硬编码了**被测程序自己的默认端口**，等于让绿色依赖于"你现在没在用它"。它比偶发失败更隐蔽，因为失败信息（`EADDRINUSE`）**完全不指向被测代码**，会把人引向"是不是端口没释放干净"。诊断过程本身也有价值：`Get-NetTCPConnection -LocalPort 7331 -State Listen` **什么都没返回**（看起来端口是空闲的），而 `netstat -ano` 明确给出 `127.0.0.1:7331 LISTENING 11728` 以及一对 `ESTABLISHED` + `FIN_WAIT_2/CLOSE_WAIT`——那是浏览器挂着 SSE 长连接的形状 | "被禁止的端口样本"**必须**写死（那正是这条用例要测的东西，6566/6000 安全：远在临时端口区间之下，且本程序不用），但"可连接的端口样本"**不得**写死任何具体端口：改成运行时经 `listenOnFetchablePort()` 取一个，断言 `isBlockedFetchPort(port) === false` **并且真的 fetch 通**（后者才是独立证据，前者只是拿同一张表验证它自己）。同时给两处 `server.close()` 补上 `closeAllConnections()`，避免 keep-alive 连接让 `close` 的 await 悬住。修复后：**在控制台仍然跑在 7331 的情况下，全量测试 0 失败** |
| 53 | **事件配色表是事件词表的第二份手抄本，两个方向都漂了**：日志面板与对话面板都用 `div.className = 'ev-' + ev.type` 生成类名，于是 `ui.html` 里的 `.ev-*` 规则必须与 `src/protocol/events.js` 的 `EventType`（14 种）加编排器的 `agent-*`（7 种到浏览器）**逐一对应**。实际是：`plan` / `usage` / `approval-resolved` / `agent-start` / `agent-final` / `agent-dispatch` / `agent-error` **七种事件没有任何配色**，同时存在 `agent-done` / `agent-user` **两条永远不会匹配的死规则**——`agent-done` 是照猜写的（真实事件名是 `agent-final`），`agent-user` 则从来没有代码发过 | 不需要触发：只要那些事件**恰好发生**，日志里就会出现一行没有任何颜色区分的文字。`agent-error`（编排器 promise 被拒时由 `web/server.js` 补发）尤其要紧——**最需要被一眼看到的那一行，恰恰是没配色的那一种** | 与缺陷 51 同源：**样式表从未与代码对过账**。它之所以能一直藏着，是因为两个方向的错误都**只在特定事件真的触发时才可见**，而不是加载页面就能看到——也就是说，靠"点开界面看一眼"根本发现不了，必须**拿代码里的词表去比对**。它还演示了一个更容易犯的错：`agent-result` 这个字符串在代码里**确实存在**（`src/cli/main.js` 里 `mesh agent --json` 往 stdout 写的一条 JSON 记录），把它当成浏览器事件加配色，就会造出一条新的死规则 | 新增 `test/ui-events.test.js`（3 例，已挂进 `npm test` 链）做**双向**断言：每个能发出的事件都必须有配色，每条配色规则都必须对应一个真能发生的事件；并加第三例**守住这个守卫**（断言 `EventType` 仍有 14 项以上、合并词表仍有 20 种以上），否则将来把枚举清空，前两条会拿**两个空集合**比对而**空洞地通过**。`.ev-*` 重写为按事件族归组并写明出处；明确注释 `agent-result` 为什么**不**收录（它是 CLI stdout 记录，永不进浏览器）。写这条时还做了一次**一次性的样式表审计**（把样式表里的选择器与 markup/JS 里实际出现的 class 求差集），它顺带发现两处死 CSS（`.required` / `.span1`）和一处**选择器根本没匹配上**的规则（`.panel > summary .spacer`——`.spacer` 实际用在 `details.subpanel > summary` 里，父节点是 `<details>` 而不是 `.panel`，所以"把 chip 顶到最右"从来没生效过），一并改为独立工具类 `.spacer`。**那次审计没有留成常设工具**：它对运行时拼出来的 class（`badge ${state}`、`'ev-' + ev.type`）必然误报，而这两类现在已分别由 `test/web.test.js` 的排版断言和 `test/ui-events.test.js` 覆盖；把带已知假阳性的检查器挂进 `npm test` 只会训练人忽略红色 |
| 54 | **「拉取模型列表」按钮发的是不带任何参数的 `GET /api/agent/models`，它只能看见"已经保存过"的配置**。而"想知道网关有哪些模型"这件事，恰恰发生在**你知道模型名之前**——按界面顺序自然操作是「填地址 → 填密钥 → 拉列表挑一个 → 保存」，而代码要求的是「填地址 → 填密钥 → **先保存** → 才能拉列表」，**顺序正好是反的**。用户照自然顺序点下去，拿到的错误是 `LLM not configured: set AGENTMESH_LLM_BASE_URL or pass --base-url.` | 在控制台里填好 API 地址与密钥后，直接点「拉取模型列表」——也就是**唯一一个你会去点它的时机**（你正是因为不知道模型名才点它） | 这是"错误的提示语把你引到错误的地方"最干净的一例：**那句话本身没写错**，`AGENTMESH_LLM_BASE_URL` 确实是一个能让它工作的变量——但一个在浏览器里填表单的人**根本没有碰过环境变量**，也不该被要求去碰。于是你会去查环境变量、重启服务、怀疑网关，而真正缺的只是"先按一下保存"。它与缺陷 30/50 同类：**报错文字与真实修复动作之间的距离，本身就是缺陷的一部分**。诊断路径也值得记：直接打**正在运行的那个控制台**的 `GET /api/agent/config`，看到 `baseUrl` 有、`apiKey` 有、`model` 为空、而 `GET /api/agent/models` 此刻返回 200——说明报错发生在保存**之前**，从而把"网关坏了"排掉 | 新增 `POST /api/agent/models`，接受 `{baseUrl?, model?, apiKey?, apiKeyEnv?}`，**只用于这一次调用**：不落盘、不调用 `applyLlmRuntime`、不改动运行中的配置，所以"只是看看有哪些模型"绝不会变成一次配置变更。只传真正给了值的字段——`{...resolved, ...{apiKey: undefined}}` 会把**已经配置好的密钥抹掉**，网关随后返回 401，而那个 401 和多出来的问号会把你引向一个与输入毫无关系的原因。`GET` 保留（CLI 与兼容用途）。界面侧 `fetchModels` 改为 POST 当前表单值；地址框为空时直接提示「请先在上面填 API 地址」，不再发出一次注定失败的请求。`listModels()` 的报错也补上界面路径（保留 `LLM not configured` 前缀以免破坏既有断言）。测试：`test/web.test.js` 新增两例——① 未保存时 `GET` 确实 502，而 `POST` 用请求里的值成功取回列表，且**事后 `llm.json` 不存在、`GET /api/agent/config` 仍为未配置**（证明探测没有副作用）；② 只传地址不传密钥时，**已经配置的密钥仍然被带上**（`Bearer`，用假网关记录请求头断言）。真实网关实测：未保存任何配置的情况下 POST 拿到 **71 个模型**，前后配置不变、未写文件 |
| 55 | **「模型」框和「密钥」框长得一模一样，但空着的含义正好相反**：密钥框空着 = **不改动**（`if (key) body.apiKey = key`），而模型框空着会把**空字符串**提交上去（`model: $('lc-model').value.trim()`），服务端 `if (typeof body.model === 'string') patch.model = ...` 照收，于是 `applyLlmRuntime({model: ''})` **把运行中的模型清空**。因为表单**每次保存都会把所有框都发一遍**，所以"只想补一个密钥"这个动作会顺手把模型抹掉：agent 立刻变成 `ready:false, missing:["model"]`，**再也跑不了**，而界面上的模型框看起来**什么都没被动过**。地址框同理（`baseUrl: ''` 会清掉地址） | 在任何一次保存里，某个框恰好是空的——**只要你不改它，它必然是空的**。用户就是这样：填了地址和密钥、点保存（此时还没拉到模型列表，因为缺陷 54 让他拉不到），模型框空着，于是 agent 被自己的"保存"弄成了不可用 | 这是"两个外观完全相同的控件，语义相反"的经典陷阱，而且它**惩罚的正是最省事的操作**（只改想问的那个框）。它还制造了一个**不可能被持久化的状态**：`saveLlmConfig()` 本来就会丢弃空值（`if (cfg.model)`），所以文件里从来没有过空模型——也就是说进程内的空模型**重启就会消失**，于是同一个"模型空着"的现象在"重启前"和"重启后"是两个不同的原因，会让人怀疑是不是持久化坏了。这一点在诊断时确实是关键：`.agentmesh/llm.json` 里**只有 `baseUrl` 没有 `model`**，正是"空值从不落盘"的证据 | 统一成"**空框 = 不改动**"：服务端 `baseUrl` / `model` / `apiKeyEnv` 三个字段都只在非空时才进 `patch`（与 `apiKeyEnv` 原有写法一致）；界面侧 `lc-save` 只提交填了的字段。**清空能力没有丢**——它只存在于那个**有专门按钮**的字段上（「清除内存中的密钥」发 `apiKey: ''`），而地址和模型本来就没有"清空"这个有意义的操作（清掉只会让 agent 不可用，且 `saveLlmConfig` 拒绝持久化空值）。两个框的说明文字也统一写上「留空 = 不改动」，让约定从"要靠读 JS 才知道"变成"写在框下面"。测试：`test/web.test.js` 新增一例，按界面真实提交的形状（`{baseUrl:'', model:'', apiKeyEnv:'', apiKey:'新密钥'}`）断言地址与模型**都不被清空**、`ready` 仍为 true、`persisted` 为 false（没有可持久化的改动就不写文件）、且密钥依旧不落盘；同一例还断言「清除密钥」按钮仍然有效。**另附一条测试卫生修复**：`src/core/llm.js` 是**单例模块**（`server.js` 每次按 `?home=` 重新导入，它 import 的 `llm.js` 却是同一个实例），里面的 `override` 会**跨测试残留**，加上 `llmConfig()` 会先读环境变量，所以这两条新用例显式清空 `AGENTMESH_LLM_*` / `OPENAI_*` 并 `setLlmConfig(null)`，否则结果会取决于开发者的环境与用例顺序 |
| 56 | **实时事件面板给每一个流式碎片都单独开了一行**：`appendLog()` 无条件 `document.createElement('div')`，而 ACP 的 `agent_message_chunk`（`src/core/adapters/acp.js` 里映射为 `chunk`，`thought` 同理）**是逐片到达的，一片可以只有一个字符**。于是用户在本机 Agent 向 NAS Agent 发出第一条命令后，实时事件里出现的是**每行一个字母**：`05:48:29node_84cde`、`…de6`、`…def`、`…de\`` ……看起来像乱码或协议故障，实际是"一行一段流"。用户自己判断"应该是跟那种流式输出有关吧"——**他猜对了** | 第一次真的跑起来、从本机 Agent 向远端 A2A/ACP Agent 发一条会产生较长回答的命令。也就是说：**只有前面所有环节都通了，这个缺陷才会第一次显形**——它是"跑通之后立刻撞上"的那一类，与缺陷 54/55 出现的位置正好相反（那两个是"还没跑通就撞上"） | 这是**唯一一类静态检查完全看不见的缺陷**：页面的 markup 正确、`.ev-*` 配色完整（缺陷 53 修完反而更漂亮地渲染了这一堆单字母行）、id 全都在、`ui.html` 能编译、`check:ui` 全绿。它坏的是**运行时的累积语义**——"同一段流的多个事件属于同一行"这件事没有写在任何类型、任何词表、任何规则里，只体现在 `appendLog` 的写法上。它也演示了"日志面板 vs 对话面板"的差异为什么不是任意的：编排器的 `agent-thought` 是**非流式**的一次完整 `res.content`（`orchestrator.js:301` 调的是非流式 `chat()`），所以对话面板本来就一行一段、无须合并；**同样的观感在两个面板里成因相反**，只看截图会得出错误结论 | 日志面板改为**合并同一段流的连续碎片**：`chunk` / `thought` 之外的事件一律另起一行，同一 `type+nodeId+taskId` 的连续碎片追加到同一行。**DOM 本身就是唯一事实来源**——只有当那一行仍然 `isConnected` 且仍是最后一行时才追加，所以「清空」按钮和 1200 行上限的裁剪都不需要额外的状态维护，也不会出现"把文字追加到一个已经离开面板的元素上、于是文字无声消失"。片段用**文本节点** `appendData` 累加（而不是拼 `innerHTML`），顺带让模型输出不可能被当作 HTML 解析。`.ev-chunk` / `.ev-thought` 加 `white-space: pre-wrap`——流里带着的换行必须保留，否则一段脚本或一张表格在流式过程中会被无声地重新排版成一行。协议侧新增 `STREAMED_EVENTS`（`src/protocol/events.js`）把"哪些事件是流"从隐含约定变成**唯一声明处**，页面里的 `STREAMING_LOG_TYPES` 由测试与之比对。**验证方式（没有浏览器，所以必须跑真代码）**：`test/ui-events.test.js` 新增 3 例，把页面里真正的 `appendLog` 源码**抽出来**在桩 DOM 上执行（抽取失败即失败，防止正则空匹配造成空洞通过），断言 8 个碎片 → **1 行**且文字完整；并做了**反证**——同一套桩喂给 `cache/ui-old.html` 里的旧实现，得到 **8 碎片 → 8 行**，形状与用户贴出的完全一致（`05:48:29` + 节点名 + 一个碎片），证明该断言不是空洞的 |

| 57 | **密码无法跨重启保留，于是"安全"的设计换来的是"每次重启都要重打一遍密码"**。本项目的规则原本是绝对的——密码**绝不落盘**，只存在服务进程内存里（缺陷 37 建立的隔离：`sshPassword` / `ssh.password` / ssh 节点上的 `password` 三种写法一律被搬进私有 `#secrets` Map，并且 `nodes.json` 里连明文残渣都不许有）。规则本身是对的，代价也真实：用户的重启频率里包含**每一次改配置、每一次看新页面**（缺陷 51 的修复就要求重启控制台），于是"重启一次 = 重打一次 NAS 密码"。用户的原话是「还有我们的这个密码该怎么保存，每次如果重启需要输入新的密码的话，会不会很麻烦很烦，我看人家都是。有可以保存密码的」——**他说的"人家"是对的**，`~/.netrc`、`~/.pgpass`、`~/.aws/credentials` 都是这个形状，而且都没有加密 | 只需要一个**真实的日常动作**：改完东西重启 `mesh serve`，然后发一条任务。第一次、第二次都还能忍，第十次就会开始考虑把密码改成短一点、好记一点的——**一个为了"更安全"而拒绝落盘的设计，最终把人推向更弱的密码**，这才是它的实际后果 | 这是本次唯一一个**用户提出的设计问题而不是报错**，也是唯一一个"改它需要先承认原设计的代价"的条目。它推翻的不是某段代码，而是**一条被写进文档的绝对规则**（`USAGE.md` §7.4 原文说 LLM 与 SSH 密码永不落盘）。值得记的是三件事：① 用户还顺带问了一个更根本的问题——「因为这涉及到了多个智能体协作，那么这个上下文的话是每次都发过去，还是每次都开启一个新的上下文？」——**他是在问设计，不是在报故障**，这两个问题属于同一类；② 做这件事时**只新增了一个文件、改了一个入口**，因为缺陷 37 当初把"密码来源"设计成了**间接引用**（节点里存的是 `passwordEnv` 这个**名字**，值从环境变量读），所以只要文件里的键值对能进 `process.env`，`registry` / `fleet` / 三个 adapter **一行都不用改**——**当初那个"多一层间接"的决定在这里直接变成了"不用改任何东西"**；③ 我在实现里**又踩了一个自己造的坑**：`loadSecrets()` 被调用两次（`bin/mesh.js` 启动时一次、`mesh secrets list` 再一次），第二次看到文件自己的值已经在 `process.env` 里，就把它判成"环境提供的"，于是把**每一个条目**都报成 `shadowed by the environment`——**一个没有任何变量被设置过的"被环境覆盖"警告**。这类报告比没有报告更坏，它会让人去查一个不存在的外部变量 | 新增 `src/core/secrets.js`（纯 Node，无依赖）：`parseSecrets` 支持 `export NAME=value`、`#` 注释、空行、单双引号，**不做转义处理**（转义是一整套语法，做一半比不做更危险）；`writeSecret` 拒绝含换行（会追加出第二个赋值）与同时含两种引号（无法无歧义引用）的值，其余内容逐行保留因而**注释不会丢**，写入 `mode: 0o600`（Windows 上 `chmodSync` 是空操作，保护来自用户目录 ACL，文档如实写明）；`loadSecrets` 的优先级是**真实环境变量优先**（与 Node `--env-file` 一致），返回 `{path, loaded, skipped, missing}` 且**只有名字、永不含值**；模块级的 `sourcedByUs` 表让重复加载**幂等**（这正是上面第 ③ 点）。`bin/mesh.js` 在 `main()` 之前加载，并且**包在 try/catch 里**——一个写坏的文件不能让 CLI 起不来。CLI 新增 `mesh secrets list / set NAME [VALUE] / rm / path`，`set` 不带值时会**关掉回显**逐字读密码（`promptHidden`：raw mode、不回显、ctrl-c 取消、退格可用），也可以 `--stdin`。界面侧把「SSH 密码」框的说明从"重启后要重填"改成**告诉你怎么让它不用重填**，并在旁边直接写出那一条命令。测试：`test/secrets.test.js`（10 例）。**诚实的前提**：这是明文文件，**保护来自权限而不是加密**；真正的更优解是改用 SSH 密钥，文档照这个顺序推荐。修复之后还用**真实 CLI**（而不是库调用）端到端走了一遍：`--stdin` 存入带空格与 `$` 的值 → 磁盘字节是 `NAS_SSH_PW="test-value with spaces $dollar"` → **新进程**里 `mesh secrets list` 报 `in effect`（这就是"重启后仍可用"）；另外拿一个三种坏输入（非法变量名、没有等号的行、未闭合引号）的文件跑 `mesh secrets list` 与 `node list`，确认 **CLI 不会因为一个写坏的文件起不来**（前两种被静默忽略是对的，第三种被点名） |
| 58 | **缺陷 53 那次"死规则审计"把 `.ev-agent-user` 当成永不匹配的规则删掉了，而它其实每轮对话都在被使用**。缺陷 53 的修复方式是把事件词表与 `.ev-*` 规则**双向对账**，而词表的来源被取成了 `src/protocol/events.js` + 编排器 + `src/web/server.js`——**唯独漏了页面自己**。但 `ui.html` 会发 `agent-user`（把用户那句话渲染进对话面板）和 `agent-error`（页面向服务端发请求失败时自己报的错），这两个类型的**唯一**发出者就是浏览器。于是审计给出"`agent-user` 从来没有任何代码发过"的结论，规则被删，`#ag-chat` 里那行"你 ……"从那天起就是一个**挂了类名却没有样式的元素** | 不需要触发——它已经生效了，只是不产生任何可见的故障：那一行照样显示，只是和答复一样是普通颜色。这也正是它能一直没被发现的原因 | 这一条最有价值的地方是它**展示了审计自身的盲区**：缺陷 53 的审计逻辑没有错、双向对账的方向也是对的，错的只是**"事件从哪来"这个前提被想当然地缩小了**（把"服务端发到浏览器"默认成了"浏览器能收到的一切"）。同一类错误在缺陷 53 里其实已经出现过一次——`agent-result` 是 CLI 写往 stdout 的记录，当时**正确地**判断它永不进浏览器；而这一次是反过来把**客户端自己的**事件当成了不存在。要发现它，必须问一句"这个词表有**几个**来源"，而不是只把已知的那几个来源遍历一遍。它也说明**删掉一条东西比加一条更需要证据**：加错一条规则只是不生效，删错一条规则会让一个正在工作的东西失去样式，而且没有任何测试会因此变红 | 把**页面自己**算作事件的第三个来源（`browserEventSources` 加入 `ui.html`），于是 `agent-user` / `agent-error` 重新成为"真能发生的事件"，`.ev-agent-user` 配色随之恢复（`color: var(--accent)`，让"你说的话"和"它的答复"一眼可分）。为了让这个前提不再靠记忆维持，`test/ui-events.test.js` 里那条双向断言现在覆盖三个来源，并在注释里写明**为什么不能只看服务端**。另新增一例针对**对话面板**的同类守卫：`appendAgent` 对不认识的类型**静默忽略**（这是对的默认行为），所以每个 `agent-*` 事件必须被显式归类为"折叠的过程"或"始终可见"之一，否则将来新增一种事件，它会在面板里**无声消失**且没有任何地方报错 |
| 59 | **对话面板把一整轮的过程和答复平铺成十几行，答复被淹在中间**：`appendAgent()` 对每个 `agent-*` 事件都 `createElement('div')` 直接追加，于是一轮"思考 → 调用 → 结果 → 派发 → 再思考 → 答复"在面板里是连续十几行等权重的文字，**你要找的那一句答复**在最后一行，而上面每一行都在争夺同样的视觉重量。用户的原话是「和本地Agent对话的时候，那个思考过程可不可以把它做成下拉式，默认把它隐藏掉，只显示回复内容。并且调用工具之类的，把它做成一个配置选项，可以让用户自己选择显示还是不显示」 | 用本机 Agent 干一件真实的事——也就是**它会思考、会调工具的那类请求**。问一句"你好"看不出来，因为它不产生思考也不派发 | 与缺陷 56 恰好构成一对：**两个面板的观感问题成因相反**。日志面板的问题是"该合并的没合并"（流式碎片各占一行），对话面板的问题是"该分组的没分组"（一整轮的过程与答复平级）——只看截图会把两者混为一谈，而修复方式完全不同（一个是累积语义，一个是结构层次）。它还牵出一个设计抉择：把过程全部藏起来**会让"它到底干了什么"也一起消失**，于是一轮什么都没做的运行和一轮被藏起来的运行看起来一样，而这恰恰是排查时最需要区分的一件事。所以这里选择**保留一行摘要**并让它计数（"过程 · 思考 8 · 调用 2"），**包括被开关关掉的类型也照样计数**——隐藏细节可以，隐藏"发生过"不行。这是一个**有意做出的取舍**，用户可以把整块折叠展开，或者在设置里打开 | 对话面板的每一轮改为一个 `<details class="run">`：`agent-start` 建块（`open` 默认 **false**），`agent-thought` / `agent-tool-call` / `agent-tool-result` / `agent-dispatch` 落进块内，`agent-final` / `agent-error` **始终在外、始终可见**，`agent-user` 也在外。摘要行由**计数器**渲染（`updateRunSummary`），因此与显示开关无关：关掉的类型照样被计入，只是不进正文。两个开关是**显示选项**——「思考过程」与「工具调用与派发」，默认都**不勾**，存在 `localStorage`（`agentmesh.display`）而不是服务端：**这是"一个人喜欢怎么读这个面板"，不是这个集群的属性**，不该跟着配置跑到另一个浏览器里。另处理了两种边界：没有 `agent-start` 的过程事件（重连、续流）会自建一个折叠块，而不是散落在答复之间；「清空对话」顺带复位 `openRun`，否则清空后第一个碎片会被追加进一个已经脱离文档的块里——**与缺陷 56 第 ② 条同一个陷阱**。CSS 一并给出折叠块的样式（`summary` 自带 ▸/▾ 指示、正文缩进、`pre-wrap` 保留模型输出里的换行）。验证方式与缺陷 56 相同：**没有浏览器，所以把页面里真正的 `appendAgent` 抽出来在桩 DOM 上跑**（`test/ui-events.test.js` 新增 4 例）；写这几例时还修了桩本身的一个不忠实之处——桩的 `textContent` 原本只拼**直接**文本子节点，而真实 DOM 是**递归**的，于是"摘要行里有没有计数"这条断言读到空字符串；修的是桩（让它像真的那样递归），不是断言 |
| 60 | **一个节点会不会看到你和另一个节点的往来，这件事在代码里是确定的，在界面和文档里却完全没说**：`store.lastSession(nodeId)` 与 `historyForContext({nodeId, contextId})` **都按节点分键**，所以跨节点**本来就不会串味**；节点内部默认**开新会话**（`continueSession` 只在 `--continue` 或编排器自己选 `continue_previous: true` 时为真），`--with-history` 也只回放**该节点自己**同一上下文里的轮次。这套语义是合理的，但**没有任何一处告诉用户**。用户的疑问因此非常具体：「比如说我刚给纳斯发了命令，然后下一条给阿里云发命令那么阿里云会不会看到之前我给纳斯发的命令，或者说nas的回复」——**这是一个无法从界面上回答的问题**，而它恰好是有正确/错误答案的那类问题（猜错的两种方向都会难受：以为会共享于是重复交代一遍，或者以为不会共享于是在协作时漏掉关键信息） | 在两个 Agent 之间来回派活——也就是用户明确想要的**多智能体协作**场景。他接着说「因为有时候会涉及到多个智能体之间的相互协作，这样的话可能会快一点儿」，所以他不只是想确认隔离，他**同时想要那个共享能力** | 这是"**语义已经正确，但没有一处可说**"的一类缺陷，与缺陷 51（排版全对、人看不懂）同源，区别是这次错的是**可发现性**而不是可读性。它值得记的地方在于用户给出的建议是"这个也做成一个可选项之类的"——**他没有要求改默认行为**，只要求把它变成一个能选的东西；这个判断是对的，因为隔离与共享各自都有正当场景，**而默认值必须是隔离**（一次跨越两个 Agent 的意外泄漏，比一次少说了几句话严重得多，而且泄漏是**静默**的）。另有一个实现上的选择值得记：共享上下文**放进发给对端的文本里**，而不是走某个传输自己的通道——ACP 有 `sessionId`、A2A 有 `contextId`、opencode 有 `?directory=`，但"别的节点最近干了什么"**不属于其中任何一种传输的概念**，塞进 `history` 参数会让对端把它当**自己的**对话历史（那是最坏的结果：它可能以为自己已经答过、于是跳过工作），所以这段文字**必须**带上明确的围栏与"这不是你自己的历史"的声明 | `store.recentTurns({excludeNodeId, limit})` 取**其他节点**最近有结果的轮次（无答案的轮次排除——那会给对端一个"没人回答过的问题"，读起来像它没做），正序返回；`fleet.send` 在 `shareContext` 为真时把它渲染成带围栏的文本段**前置**到外发文本上（真实请求**排在最后**，对端先读到的是任务），每段提问与答复**分别截断**（400 / 800 字符），否则一条大结果会把真正的请求挤出上下文；`registry` 只用来取节点名，取不到就退回用 id，绝不让渲染失败影响派发。**落库的任务记录仍然是用户原话**——`mesh task <id>` 读回来不该是一屏别人的历史（这条有测试钉住）。开关贯穿四层且**默认全关**：CLI `--share-context` / `--share-limit <n>`、Web 发任务面板的「带上其他节点的最近往来」、编排 Agent 面板的「跨节点共享上下文」（作为**运行级策略**而不是给模型的工具参数——同一个请求在不同日子不该因为模型的选择而表现不同）、以及 `broadcast` 的透传。测试：`test/shared-context.test.js`（5 例），其中第一例就是**默认隔离**的正面约束：对端收到的文本与提问**逐字相同**，多一个字符都算失败 |

| 61 | **远端（A2A）停下来等人做决定时，本机只留下一个状态名；而且"请咨询我"那个开关被静默丢掉了**。两半合成一个缺陷，因为它们是同一个场景的两面。① `A2aAdapter` 完全不认 `permissionPolicy`——`fleet.send` 里那句 `if (opts.permissionPolicy && 'permissionPolicy' in adapter)` 对 A2A 恒为假，于是 `--approval ask` **被无声丢弃**：操作员明确要求"要问我"，程序收下了这个要求，然后什么也没问。② 对端返回 `TASK_STATE_INPUT_REQUIRED` 时，本机的处理是：状态正确映射成 `input-required`、对端的问题也**确实**作为 `chunk` 到了、`contextId` 也存下了——但**没有任何东西说"没人在干活，在你回答之前什么都不会发生"**，也没有一条可照抄的回答方式。命令行的收尾只有 `input-required  task=…  context=…` 加一个非零退出码 | 让一个**合规**的 A2A 对端返回 `input-required`（它完全按协议做），并且操作员事先打了 `--approval ask`——也就是**最自然的那次尝试**。这个组合下"有人在场"和"人被告知了"之间没有任何联系 | 这是缺陷 54/50 同一类的第三例：**报错（或这里：沉默）与你该做的动作之间的距离，本身就是缺陷**。它尤其值得记的是**它被实测推翻了一次想当然**：读代码时会以为"对端的问题根本没到本机"，实际用探针跑出来才发现 `chunk` 和 `result` 里**都有原文**——真正的缺口比想象的窄、但也更隐蔽：信息在，**"该你了"这句话不在**。第二半（静默丢弃开关）还暴露了一个不对称：本项目对**密钥**极严（三种写法一律隔离、原始字节断言），却对一个"要求人工在场"的开关可以零提示地当没看见。诊断过程本身也留了件工具：`cache/probe-a2a-approval.mjs` 用临时 home + mock 对端把事件流、任务记录、审批表**并排打出来**——"什么都没发生"这种断言最容易靠读代码读错，所以必须跑出来看 | ① 在 `src/protocol/events.js` 新增 `NEEDS_INPUT: 'needs-input'`，**刻意不复用 `APPROVAL_REQUESTED`**：审批是**选项式**的（ACP/opencode 给出固定选项，面板能渲染成按钮），而 A2A 的 `input-required` 要的是**自由文本**，把它做成审批会在面板里放一个**按下去却带不出你要说的话**的按钮。事件里带 `question`（对端原话）、`contextId`、以及 `replyWith`（可照抄的命令）。② 信号由 `fleet.send` 这个**传输无关层**发出——判据是 `WAITING_STATES`（这个判定函数此前**声明了却全项目没人用**，现在它是这句话的唯一出处），所以将来任何新传输只要停在等待态就自动获得同一个信号。③ `--approval` 打在**没有权限通道**的传输上时发一条 `log` 事件，点名传输、点名原因、点名出路（`Use an ACP node for approvals, or answer with: mesh send <node> "<answer>" --continue`）；ACP/opencode 照旧设置策略且**不产生任何噪音**（有测试钉住两个方向）。④ 命令行收尾变成一段能照着做的说明：状态徽章 + 「远端在等你回应 —— 它没有失败，是停下来等人做决定。」+ 对端原话（最多 20 行）+ 那一条命令；**没拿到 `contextId` 时额外提醒** `--continue` 可能会开一段新会话。⑤ 控制台给 `needs-input` 一条醒目样式（黄色加粗 + 左侧色条，**比错误更抢眼**，因为这是唯一"缺的就是你"的状态），并附一句**用这一页自己就能回答它**的说明（选同一节点 → 勾「续接上次会话」→ 填回答 → 发送）——浏览器用户不该被递一条 shell 命令。`.badge.input-required` 的配色本来就存在，任务表里因此也会显眼。测试：`test/fleet.test.js` 新增 5 例（等待态发出 `needs-input` 且**带对端原话与可照抄命令**、发出顺序在 `done` 之前、完成的任务**不**谎称在等人、**没有问题时也必须报告而不是沉默**、无权限通道的传输**必须警告**且有通道的传输**必须不警告**）；`test/ui-events.test.js` 新增 1 例（桩 DOM 跑真的 `appendLog`，断言原话出现、回答方式出现、且**没有上下文时的提醒不同**）。**反证**：`cache/mock-a2a-input-required.mjs` 起一个会在问题里带上 `[o]nce \\| [s]ession \\| [d]eny` 的对端，用**真实 CLI** 跑，确认修复前只打印一行状态名、修复后打印上面那一整段 |
| 62 | **事件词表的"来源"是一份手写清单，于是在缺陷 58 修好它一处之后，同一类错误立刻又有第二处**。缺陷 58 的修法是把"页面自己也是事件来源"补进 `browserEventSources`——但那个变量本身仍是**手写的三个文件名**（`orchestrator.js`、`server.js`、`ui.html`）。也就是说：58 修的是**症状**（`agent-user` 被误删），**根因**（"来源靠人记"）还在。这次一动 `fleet.js`（新增 `needs-input` 的发出点）就立刻撞上：`fleet.js` 不在清单里，于是它发的事件对审计**不存在**，而颜色反向检查也会把新增的 `.ev-needs-input` 判成"永不匹配的死规则"——**同一把刀，第二次落下** | 不需要触发：只要有人在一个"清单外"的文件里发事件。这类缺口不会报错，只会让审计给出**看起来很有把握的错误结论**（"这个类型从来没被发出过"），而结论错了就会导致**删掉一条正在生效的配色** | 它与缺陷 58 是同一根因的两次显形，区别在于这次修的是根因而不是又一例症状：**"事件从哪来"这个问题不应该有一个人工维护的答案**。同时它演示了一个反直觉的地方——把扫描范围**扩大**（从 3 个文件到整棵树）反而立刻撞上一个**必须排除**的目录：`src/cli/` 里 `reportAgentRun` 会写 `{ "type": "agent-result", … }` 到 **stdout**，那是给机器读的记录、浏览器永远收不到；无条件扩大范围会反过来**要求**存在一条永远匹配不上的 `.ev-agent-result` 规则，也就是缺陷 53 里已经明确判定"不该收录"的那一条。所以修法必须是"扩大**并且**把边界写成有理由的规则"，而不是"把清单改长一点" | `eventSources()` 改为**遍历 `src/` 整棵树**（递归收集 `.js`，再加页面本身），唯一排除的是目录级规则 `src/cli/`，并在注释里写明**为什么**：CLI 是事件的**消费者**（渲染到 stderr）兼 stdout 记录的**生产者**，`agent-result` 就是那个反例。同时新增一例**把前提本身钉住**的测试：断言扫到的文件数 ≥ 20、页面在来源里、`agent-user` 在词表里（58 的正面约束）、`agent-result` **不**在词表里（53 的判定）、以及扫到的内容里**不含** `reportAgentRun`（排除规则本身）。这样将来有人把范围缩回去，红的是"前提"这条测试，而不是几周后某条配色被悄悄删掉 |

> 第 11 条本身不是产品缺陷，但它是**方法论教训**：缺少进程身份标识时，验证会指向错误的结论。已固化为 `/healthz` 的能力。
>
> 第 12–15 条有个共同点：**它们全都藏在"没人跑过的分支"里**。12 和 15 是 CLI/配置里从没被真实用过的路径，
> 13 的调用方一直传错了类型而没人发现，14 则是"实时看得见、事后拿不到"的那一类——单测覆盖了适配器内部，
> 却没有一个测试从 CLI 的输出契约端去断言。
>
> 第 16–19 条要把功劳记在**换了一台真机器**上。四条里有三条是纯 argv/命令行的错，本地 mock 与单元测试都
> 看不见：16 需要一个真的远端 shell 才会回 exit 127，17 需要真的执行多语句命令才会暴露"后半段没跑"，
> 19 需要一个**真实子进程**才能让陈旧回调在正确的时间点触发。**19 尤其值得记：它让"探测过的节点发不出任务"，
> 而这正是 Web 控制台的正常流程——任何只跑单测、或只用 CLI 单发一条命令的验证都不会碰到它。
>
> 第 23 条是**写 `USAGE.md` 时抓出来的**：为了把 `mesh cancel` 的用法写准确，去读它的实现，才发现它在撒谎。
> 它和第 19 条一样，**只在"跨进程"这个真实用法下暴露**——单进程内调用看起来完全正常。
> 这也说明：**给一个行为写文档，本身就是一种验证**。
>
> 第 29–31 条是一组，全部由 **CLI 参数解析**引入，而且都是**静默**的：29 会悄悄改写用户的提示词，
> 30 让权限闸门"传了等于没传"，31 让运行报告虚报工作量。它们的共同触发条件是**开关写在句子的
> 前面**——恰恰是人的自然写法（`mesh agent --dry-run "把 X 做掉"`）。32–33 则是"编排器自己的代码
> 质量"这一类：一个抛异常的工具、一个写错的字段名，都不会报错，只会让功能悄悄变差。
> 34–35 记在**测试与验证工具自己身上**：验证脚本说谎比产品有 bug 更危险，因为它会让你去修一个
> 不存在的问题（35 就是这样，第一轮跑出来的两条"失败"全是脚本自己的错）。
>
> 第 36–50 条是一次**用户报障**追出来的，而且它们有一个共同点：**全部集中在控制面**，
> 而此前所有验证都是从 CLI 发起的。36 是界面**按设计就做不出用户要的那种节点**；
> 37 是密码**泄露了却没换来功能**（最坏的一种）；38 是"改一个字段"的代价是**丢历史**；
> 39 是**最该有信息的地方信息最少**；40 是填密钥**反而把好配置抹掉**，让归因指向错误的方向；
> 41 是功能全对但**资源泄漏**，被清理时的 EPERM 才暴露；42 和 43 是一对——
> 42 让"删字段"这个意图**把字段写成 `true`**，43 说明注册表**根本没有删字段的能力**，
> 于是两个缺陷叠起来构成一个死局：**泄露容易，撤回没有路**。
> 44 是**只有浏览器能发现**的那一类：用一个 `parentElement` 隐藏字段，结果把整个注册表单隐藏掉——
> 接口全对、单测全绿，坏的只是 DOM 结构，而这个项目当时**没有任何非浏览器检查**能看见它。
> 45 则是**修 A 坏 B**的典型：为了拒绝垃圾输入而加的校验写在了错误的层（构造好的 payload 而不是
> 原始 flags），**顺手把 `--local` 这条最常见的合法用法也拒了**；同处还暴露出缺值的 `--ssh-port`
> 会**静默变成端口 1**。42→43 是"两个缺陷叠成死局"，45 是"一个修复自己长出新缺陷"——
> 这一类只有**回归测试**能钉住，而它确实是被一条回归测试钉住的。
> 46 又换了一个类别：**偶发**（24 次全量跑挂 1 次），而且根因在**规范**里而不在代码里——
> `server.listen(0)` 拿到的端口有一部分是 fetch 按 WHATWG 规范拒绝连接的。它失败的测试
> 与被测代码**毫无关系**，这类缺陷比硬失败更危险：**它会训练所有人"重跑一遍、忽略红色"**。
> 而定位它的过程本身也值一句：单跑 3 次全过（像环境问题）→ 密集循环 30 次复现 1 次 →
> **把完整输出落盘才看见真正的错误是 `bad port` 而不是断言失败**——只看"哪个断言挂了"
> 会一路查错方向。
>
> 这一组说明的道理和第 19 条相同、但方向相反：19 是 CLI 单发一条命令看不到，
> 36–50 是**只测 CLI 就永远看不到**。同一个系统的两条入口（命令行与控制面），
> 各自的缺陷只有各自跑得到——**"有测试"不等于"有覆盖"**。
> 44 还把这句话推到了下一层：**"有检查"也不等于"有覆盖"**——直到 `check-ui.mjs` 有了
> **第 4 条规则**（禁止用 DOM 位置切布局）并且**这条规则自己有自测**（`check-ui.selftest.mjs`
> 会注入这个真实缺陷、断言检查器必须报错），这一类问题才算真的被覆盖了。
> 而 48 又把"检查器本身可信吗"再推一层：那个检查器**曾经在注释里扫代码模式**，
> 于是"把规则解释清楚"反而会让它报错，逼你把注释删掉；更麻烦的是**修它的第一步静默失效了**
> （剥离注释的代码不认识正则字面量，`/[&<>"]/g` 里的 `"` 让扫描器状态错乱，
> 于是后面所有注释都没被剥掉）。**"改好了但没生效"是比原缺陷更难查的一类**，
> 而它唯一的解药是把契约写成自测：现在有一条用例就叫
> 「注释里描述缺陷不得被当成缺陷」。自测因此从 6 条变 7 条——**验证工具自己的行为也要被钉住**。
> 49 则收在最小、也最容易被跳过的地方：**一条私有通道**（送密码进 ssh 子进程的那个环境变量）
> 和**一个被文档说成"只读"的访问器**（`runtimeNode()` 在没有密码时返回活对象，改副本能污染注册表）。
> 它们共同的特征是**没有症状**——通道断了只会退化成一句含糊的告警，访问器被改则可能在
> 下一次 `save()` 时把改动落盘。**"没有症状"不等于"没有问题"，只等于"没有人看"**。
> 50 则回到了这一组最核心的那个问题：**同一个人、同一件事，在界面里做和在命令行里做结果不同**。
> 它建出来的节点带着一份**永远用不上的密码**，并且打印了一句**本身没错、但把你引向错误方向**的提示。
> 这一条也正是"文档如实描述了一个错误行为"的样本：文档没错，实现错了，
> 而**"两条入口彼此一致"是一个必须单独验证的维度**，它不会被"文档与实现一致"覆盖。
>
> 顺带一条**方法论教训**（与 45 同源）：给一个校验写测试时，如果只测"该拒绝的拒绝了"，
> 就会漏掉"不该拒绝的也被拒了"。45 的回归测试专门断言 `--local` / `--shell` **不得**被误报——
> **校验的测试必须同时覆盖两侧**，否则修好一个坏输入会悄悄弄坏一个合法输入。

### 4.1 验证过程中的一次自伤事故（如实记录）

用 PowerShell 5.1 批量删除适配器里的重复直连时，我用了 `Get-Content -Raw` + `Set-Content -Encoding UTF8`。
PS 5.1 默认按 **ANSI(GBK)** 读取无 BOM 的 UTF-8 文件，于是四个适配器文件里的中文全部变成乱码，
且**关闭引号的字节被 GBK 双字节序列吞掉**，直接导致语法错误。

- 影响面：`src/core/adapters/{acp,a2a,opencode,cli}.js` 四个文件，仅非 ASCII 字节。
- 恢复：没有 git、没有备份。利用变换的确定性做逆向（UTF-8 字节 → 按 CP936 解码成串 → 再按 CP936
  编码回字节），19KB 的文件只丢了 6/1/4/3 个字符（多为注释里的破折号 `—`，以及
  `'允许一次'` 的「次」和引号、`<args>` 的 `>`），逐个手工补回。最终 4 个文件均为合法 UTF-8，
  全仓库乱码特征扫描为 0，73/73 测试通过。
- 教训：**在这个仓库里永远不要用 PowerShell 的 `Get-Content`/`Set-Content` 改这些文件**；
  用编辑工具，或显式指定 UTF-8 的 .NET API。恢复脚本本身已删除——它对正常文件重跑会造成同样的破坏。

---

## 5. 未验证项

以下项目**没有**做过真实端到端验证，请勿按"可用"对待：

1. **SSH 传输本身** —— 这一条**已经从"未验证"转为已验证**，见 3.6。真实 sshd、真实密码登录、
   真实主机密钥校验（`accept-new` 首用即存）、真实远端 POSIX 路径与 PATH、真实网络，全部实跑通过。
   仍未验证的只剩其中几项：**密钥认证**（本 NAS 无家目录，需 `sudo` 建 `/home/user`，属于对用户系统的
   持久改动，本次未做）、**`ProxyJump`/跳板机**、**网络中断与超时的恢复行为**。
2. **opencode 端到端**：本机未安装 opencode。适配器是对着**逐字节复刻其线格式的 mock** 验证的
   （含 `prompt_async`+`/event`、权限作答、`?directory=` 作用域），未对真实 `opencode serve` 跑过。
   注：调研所用的 `packages/sdk/openapi.json` 与 tag `v1.18.31` 逐字节一致，故线格式依据是可信的。
3. **真实 A2A 对端** —— **已完成**，见 3.7。对着一个**真实的第三方公网 A2A 实现**
   （别人在云上跑的 Hermes v0.14 A2A 桥，背后是真实 LLM）完成了三件事：
   卡片发现 → 派发任务 → 拿到响应（`verify-a2a.mjs` live **10/10**）；
   一次**真正的多轮对话**（含专门的记忆测试，见 3.7.3）；以及由对端把会话**落盘到它自己的服务器**。
   过程中依次解决并修复了四个真实互操作问题（网络失败无法归因、卡片宣告内网地址、
   v0.3 与 v1.0 方法名差异、`--continue` 不夹带历史导致"假对话"，见缺陷 24/26/27/28）。
   另外内置的**真实 A2A v1.0 服务端**（`tools/fake-a2a-server.mjs`：真 HTTP / JSON-RPC / SSE /
   强制鉴权）覆盖流式 artifact `append` 语义与 v1.0 方法名，**23/23**。

   仍然**没有**验证的：真实的 `input-required` 往返（需要人在对端真正触发一次审批）、
   A2A 的 `pushNotifications` 回调路径（对端 `push=false`），以及**对端落盘文件的独立核验**
   ——该云主机只有 A2A 可达、没有 SSH 凭据，所以"文件内容确实如此"目前只有对端自述（见 3.7.3 末注）。
4. **ACP v2**：未实现。官方明确"不要默认在生产启用"，本项目只实现稳定版 v1。
5. **`fs/*` 与 `terminal/*` 客户端能力**：默认不宣告（设计选择，见 PLAN.md 原则 4）。
   `fs/*` 的分支代码有实现但**从未被真实 agent 触发过**。3.6 里那次"Approve edit"说明远端 Hermes 会走
   它自己的编辑工具；由于我们没有宣告 `clientFs`，写入**确实发生在远端**（已用 ssh 独立读到），
   但**"如果宣告了会怎样"没有验证过**——这条边界值得在真实使用前想清楚。
6. **多节点并发扇出（`mesh broadcast`）**：目标选择逻辑已有单测，但**只有过一个真实远端节点**，
   没有两个真实节点同时实跑过。而且：**`--mode best` 根本没有实现**——代码里只有 `first` 有分支，
   `best` 与 `all` 行为完全相同（只是把结果按节点名排序）。`--mode first` 也**不是严格竞速**：
   它按并发池派发，所以"停止"之前可能已经起了多个任务。
7. **跨平台**：控制面只在 Windows 上验证。POSIX 分支（`findSshBinary` 非 Windows 路径、
   `buildSshArgs` 在真实 Linux 控制面上的行为）未实跑；**被控端这次终于是真实 Linux 了**（Debian 12）。
8. **非 OpenSSH 客户端**：`--ssh-binary` 的真实用法本次验到了——但用的是"node 包装器 + Windows 自带
   ssh.exe"，**真正的 plink 仍未接过**（plink 的参数与输出格式都不同）。
9. **`mesh send --approval ask` 的交互式 TTY 提问**：3.6 里 `ask` 的挂起与作答是从事件循环外驱动并验证的
   （`resolveApproval` 返回 `{ok:true}`），但**没有在真实 TTY 上人工敲过数字**。
10. **长时运行的稳定性**：未做长时间/高并发压测。远端 `/tmp/mesh-hermes` 这个数据目录也**不是持久方案**，
    重启即失效（见 3.6.2）。
11. **`mesh cancel` 的固有限制（已改为诚实报错，但限制本身消不掉）**：取消必须**经活动连接**写回给 agent，
    所以**只有持有该任务的那个进程能真正叫停它**。从别的终端 `mesh cancel` 现在会明确拒绝并保持记录不变
    （第 23 条），但"想跨进程叫停"这件事本身**做不到**——正确用法是让 `mesh serve` 常驻并由它派发，
    或者用 Web 控制台的取消按钮（那个进程确实持有连接）。这条已由 `test/cli-cancel.test.js` 钉住。
12. **`mesh watch` 的实时范围**：它只订阅**本进程**产生的事件，因此看不到另一个终端里 `mesh send` 的实时流
    （`--task <id> --follow` 能回放已落库的历史）。**审批不受影响**，因为它落库且可寻址。
    想要真正的跨进程实时流，用 `mesh serve` + `/api/stream`（控制台就是这么做的）。
13. **编排 Agent 的模型面**：`tools/verify-agent.mjs` 用**脚本化** LLM 覆盖了循环的每条分支，
    真实运行则只用了 `deepseek/deepseek-v4-pro` 一个模型。换模型（尤其工具调用格式不那么标准的）
    在本机上**没有跑过**——虽然 `mesh agent models` 能列出网关提供的模型。
14. **编排 Agent 的交互式 TTY 与 `--confirm`**：REPL 与 `--confirm` 的提问分支**没有在真实 TTY 上
    人工敲过**（与第 9 条同类）。已测的是：`stdin` 不是终端时 `--confirm` **默认拒绝**（这条是刻意的，
    且被 3.8.1 钉住）；真实 TTY 下的问答路径未验。
15. **整个 Web 控制台都没有在真实浏览器里渲染过**（这一条从编排 Agent 的对话面板**扩展到了全部面板**）。
    验证到的是——控制台返回的 HTML 里确实含有各个面板与全部处理逻辑（`tools/check-ui.mjs` 逐项静态
    断言：内联脚本可编译、每个 `$('id')` 都有对应 `id=`、每个 `dataset.x` 都有 `data-x` 产出、
    **每个控件都有标签归属**、**没有行内样式**、**静态 class 都有对应规则**、
    **标签闭合/id 不重复/`<style>` 括号平衡**）、
    每个接口都用浏览器那套 HTTP 调用打过（`test/web.test.js` 打本地、`verify-console.mjs` 打真 NAS）、
    `POST /api/agent` 返回 202、**SSE 上确实收到 6 个 `agent-*` 事件**、派发出来的任务出现在同一个
    Store 里。**没有做的**是打开浏览器看它画出来对不对（本项目全程无浏览器可用）。
    也就是说：**SSE → DOM 的渲染路径、以及新表单/新面板的实际交互（下拉联动、编辑回填、
    密码框显隐、模型列表 `datalist`），全部属于未验证**。`check-ui.mjs` 能挡住"id 拼错"、
    "控件与标签失联"、"表单被未闭合标签吞掉"，挡不住"画出来不好看/不像我想的那样"。

    > 这一条在**缺陷 51**（用户反馈"完全不知道哪个框对应哪个框"）之后加强了，但**没有被消除**，
    > 而且要说清楚加强到什么程度：新增的静态规则与 `test/web.test.js` 里那条"对真正发出去的字节
    > 做排版断言"的用例，覆盖的都是**排版崩溃的成因**（无分组、行内样式互相打架、标签失联、
    > 标签未闭合、class 拼错），不是**排版的结果**。改版后的页面**仍然没有人看过一眼**。
    > 一个具体的、可被反驳的点：`prefers-color-scheme` 的**浅色**分支（整套 `:root` 变量）
    > 从未在任何浅色环境下显示过；显式 4 列网格在**窄窗口**下的折行只有媒体查询能被静态读到，
    > 实际折成什么样未被观察。这两处如果要下结论，必须真的打开一次浏览器。
    >
    > 还有一条**操作上的陷阱**，它不属于"未验证"而属于"会让人误以为验证失败"：
    > `createConsole` 在启动时用 `readFileSync` 把 `ui.html` **读进内存**，此后再不读盘。
    > 所以**改了 `ui.html` 而不重启 `mesh serve`，浏览器里看到的仍是改版前的旧页面**——
    > 用户报告"排版还是乱的"时，第一个要排除的就是这个，而不是去改 CSS。
16. **同一个控制面进程内并发跑多个编排 Agent**：代码允许（每次运行有独立事件流），但**没有并发实测过**。
17. **编排 Agent 的多节点真实扇出**：`broadcast` 在 `verify-agent.mjs` 里对两个**假**对端验证过
    （两边都收到、答复都收齐）；对**两个真实节点**扇出，与第 6 条同样未做。
18. **`tools/verify-console.mjs` 在受限沙箱内会失败，且失败路径上会打印一条 libuv 断言**：
    该脚本必须 ssh 到真 NAS，而沙箱拒绝带管道的子进程 spawn，于是它有 **2 项**会失败（`spawn EPERM`），
    并且**进程退出时会打印一次** `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
    （`src/win/async.c:94`，与缺陷 34 同一个断言）。**提权后是 21/21，且这条断言不再出现**。
    因此目前的结论只能是：**该断言只出现在"沙箱拒绝 spawn"这条错误路径上**，
    **真实运行未复现，根因也未定位**——它可能只是沙箱特有的清理时序问题，也可能是别的资源泄漏
    （缺陷 41 修掉的 SQLite 句柄是**同一个症状类别**的另一例，但两者是否同源没有查证）。
    在有权限的环境里复跑时应留意它是否再现。

    **同一个沙箱里，`tools/check-ui.selftest.mjs` 却是通过的**——因为它**直接 `import` 检查器的
    `analyzeUi()` 函数**，而不是 spawn 一个子进程去跑检查器。这个区别不是巧合，它本身就是一条设计规则：
    **自测要在最受限的环境里也能跑**，否则"检查器坏了"和"环境不让跑检查器"会混成同一件事，
    而后者会让人养成忽略失败的习惯。两相对照也说明：这个项目的验证工具**对 spawn 的依赖是真依赖**
    （`verify-console` 必须 ssh 到真机，`check-ui.selftest` 不必），不是可以随手绕开的形式问题。
19. **模型面板只在一个真实网关上试过**：`.agentmesh/llm.json` 的落盘边界与"只填密钥不清空端点"
    这两条逻辑（缺陷 40）有单测；「拉取模型列表」「保存并测试连接」这些动作是对着**同一个局域网
    OpenAI 兼容网关**（`http://10.0.0.5:8000/v1`）跑的。换一个**鉴权方式不同、或不是 OpenAI
    兼容形状**的端点，没有验证过。
20. **`BLOCKED_FETCH_PORTS` 是一份会随 Node 版本漂移的副本**（缺陷 46）：那份禁止端口列表是
    **规范（WHATWG fetch）与当前 Node 实现**的快照，本项目只是把它抄了一份并**实测核对**过
    （6566 / 6667 / 6000 / 4045 / 10080 / 5060 / 1 / 22 / 25 / 4190 实测被拒，7331 / 2222 /
    49152 / 51234 可连）。**规范若增删条目、或 Node 换了实现，这份副本就会过时**。它不会静默过时：
    `test/net.test.js` 第 ② 条**实测硬编码列表与当前 Node 的行为是否仍一致**，一旦漂移就失败，
    于是它会变成一个"需要更新常量"的明确信号，而不是重新变成随机 flake。
    换句话说：**这份副本的准确性本身是被测试钉住的，但钉住的是"和本机 Node 一致"，不是"永远正确"。**
21. **`listenOnFetchablePort` 的"重掷"次数上限**：默认 12 次，掷不到可用端口就报错（不是死循环）。
    在禁止端口占 82/65536 的情况下 12 次几乎不可能全中，但**这个上限没有被真实高负载场景验证过**
    （比如同时起几十个测试服务器、端口空间被挤占时）。它失败的方式是**明确报错**，不是超时或挂死。

    > **补记（已验证，不是推测）**：解除沙箱限制后跑了**同一套全量**，结果是
    > `tests=217 pass=217 fail=0 skip=0`——也就是说受限环境里那 8 个 `skipped`
    > **确实只是沙箱产物**（禁止管道 stdio 的 `spawn`），**不是功能缺失、也不是已知失败**。
    > 连带其余 209 例一起 **217/217、0 跳过、0 失败**。因此第 1 节的"提权后 217/217"
    > 是**实测得到**的，而不是推断出来的。

22. **ssh 失败原因的改进只在"连不上"这一类故障上实测过**：对一台**不存在的主机**
    （`10.0.0.250`，专门用一个死地址，这样**不需要任何口令**——失败发生在认证之前）
    执行 `mesh node check`，输出为
    ```
    error: acp:deadhost closed: process exited (code=255)
    ssh: connect to host 10.0.0.250 port 2222: Connection timed out
    ```
    修复前这里**只有** `process exited (code=255)`，没有任何原因——那正是用户最初抱怨的
    「探测报错看不到原因」（同类现象还有 `UNKNOWN port -1: Connection refused`）。
    做法是 ACP 适配器对 ssh 的 stderr 保留一个 **8 行环形缓冲**，把最后几行并进关闭原因。
    **边界**：这条改动在"连接超时 / 连接被拒"上实测有效；对**别的失败类别**
    （能连上但认证失败、能认证但远端命令立刻退出、ssh 二进制本身缺失等）的输出质量
    **没有逐类验证过**——环形缓冲只有 8 行，一个话很多的 ssh 仍可能把关键行挤掉。

---

## 6. 环境相关说明（复现时会遇到的）

- **文件沙箱**：本次验证在受限沙箱内进行，`child_process.spawn` 的**管道 stdio 会被拒绝**
  （`spawn EPERM`），且禁止写工作区外的路径。而 ACP 的稳定传输**只能是 stdio**，Hermes 也需要写
  `%LOCALAPPDATA%\hermes`。因此真实端到端验证是在**单次提权（full access）**下完成的。
  这是验证环境的限制，不是产品限制。
- **`node --test test/`** 在同样受限的环境下会失败：测试运行器本身要开子进程。直接
  `node test/<file>.js` 最稳（`npm test` 已按此方式配置）。
- **不要用 PowerShell 5.1 的 `Get-Content`/`Set-Content` 改仓库里的文件**（见 4.1）。
- **也不要靠 PowerShell 的 `>` 重定向留 UTF-8 日志**：本次实测 `node … --json > log.ndjson` 写出的是
  **UTF-16LE**，下游 `JSON.parse` 直接报 `Unexpected token '\uFFFD'`。日志由程序自己按 UTF-8 写
  （`tools/verify-lan.mjs --log` 就是这么做的），或读回时先按 BOM 判编码。
- **通过 PowerShell 管道把脚本喂给远端 `bash` 会被改写换行**：`Get-Content -Raw | ssh host "bash -s"`
  实测报 `bash: line 39: $'\r': command not found`。可靠做法是 base64 打包成一行再在远端 `base64 -d`。
- 验证脚本写盘位置：`logs/`（已 gitignore）。本次真机转录：`logs/lan-acceptance.txt`。

---

## 7. 结论

以"本机 Hermes 真实打通 + **跨机器真机跑通**"为验收口径，**通过**：

- ACP over stdio 的真实互操作：握手、能力解析、会话、提示词、流式更新、审批往返、执行结果 —— 全部实跑通过。
- **ACP over SSH 到一台真实局域网主机**：真实 sshd、真实密码认证（`SSH_ASKPASS`，密码不读 stdin 因此
  不污染协议管道）、真实远端 Linux、真实远端 Hermes `0.18.0`；两个任务（一个自动放行、一个挂起等人裁决）
  都在远端磁盘上留下了产物，且产物由控制面**独立读回核对**（内容、`md5`、`mtime` 三项）——实跑通过（35/35）。
- 统一状态模型、任务/事件/审批持久化、Web 控制台 API 与 SSE —— 实跑通过（15/15）。
- **A2A 通道** —— 对着真实第三方公网对端端到端跑通（live 10/10），完成**真正的多轮对话**
  （含记忆测试）并由对端落盘会话记录，见 3.7；另以内置真实 A2A v1.0 服务端覆盖流式与 v1.0 方法名（23/23）。

真实端到端跑通的那一刻之所以有意义，是因为它**推翻了 62 个"看起来没问题"的地方**。
按危害排序，最该记住的是第 1、2、3、12、14、19、23、24、26、27、28 条：审批全部变拒绝、审批永久阻塞、
结果恒为空、按能力扇出选中 0 个节点、消费方永远等不到结束事件、**控制台对刚探测过的节点永远发不出任务**、
**取消一个任务会谎报成功而 agent 其实还在干活**、**所有网络失败都显示成同一句 `fetch failed`**、
**盲从卡片里的内网地址把超时伪装成防火墙问题**、**只用 v1.0 话术导致能用的对端被判为失败**、
以及**"多轮对话"其实每轮都是孤立的、而客户端一声不吭**。
其中第 19、23、28 条都属于那一类**"界面/日志上看起来完全成功，实质上什么也没发生"**的缺陷——
这也是本清单里最难靠单测发现、最需要真实使用才会暴露的一类。
第 24、26、27、28 条则都是**去连一台真实的、别人写的服务器**才现形的。

### 7.1 最终合并运行

交付前在**当前代码**上做了一次合并复跑（`npm test` 会在受限沙箱内自动跳过 8 个需要真子进程的用例并说明原因）：

| 检查 | 结果 | 日志 |
|---|---|---|
| `npm test`（18 个文件 / 217 用例） | **209 通过 / 8 沙箱跳过**，exit 0 | — |
| `node test/acp-lifecycle.test.js`（真子进程） | **3 / 3**（提权后实跑） | — |
| `node test/cli-cancel.test.js`（真子进程 + 桩 daemon） | **5 / 5**（提权后实跑） | — |
| `node test/web.test.js`（真控制面，`fetch` 按浏览器那套调用） | **20 / 20** | — |
| `node tools/verify-a2a.mjs`（**内置真实 A2A v1.0 服务端**） | **23 / 23** | — |
| `node tools/verify-a2a.mjs --url http://123.56.124.199:9900 --token …`（**真实第三方公网对端**） | **10 / 10** | — |
| `node tools/verify-ssh-acp.mjs`（ACP over SSH 路径） | **13 / 13** | — |
| `node tools/verify-approval.mjs`（真实 Hermes 审批闭环） | **15 / 15** | `logs/final-acceptance.txt` |
| `node tools/verify-lan.mjs`（**局域网真机验收**） | **35 / 35** | `logs/lan-acceptance.txt` |
| `node tools/verify-agent.mjs`（**本地编排 Agent**，见 3.8） | **28 / 28** | `logs/agent-acceptance.txt` |
| `node tools/verify-console.mjs`（**真控制面 + 真 NAS**，见 3.9） | **21 / 21**（提权后实跑；沙箱内 2 项失败，见第 5 节 18） | — |
| `node tools/check-ui.mjs`（控制台界面静态自检） | **UI OK**（脚本可编译 / 61 处 id 查找全有对应 / 10 处 `data-*` 全有产出） | — |
| `node tools/check-docs.mjs`（**文档自检**） | **ALL CONSISTENT**（跨文档计数一致、链接可解析、缺陷表连续） | — |
| `mesh agent "让 nas-hermes 写一个 is_prime 函数…"`（**真实 LLM + 真实 NAS agent**） | 派发成功、代码原样返回、并如实转述远端的拒绝 | 见 3.8.2 |

> 运行环境注明：上面这一轮是在 **Node v24.16.0 / Windows** 上复跑的。项目此前主要工作在
> Node v22.23.2 上，`engines` 要求 `>=22.5.0`，两个大版本下结果一致。换版本后重跑时发现
> `test/llm.test.js` 会崩在 libuv 断言上（缺陷 34）——**那是测试收尾泄漏长连接 + 强制退出抢跑**，
> 修好后两个版本都干净退出，与产品代码无关。

`mesh cancel` 修复前后的实测对照（同一台机器、同一个陈旧 `working` 任务、同样没有 daemon）：

```
修复前:  ✓ canceled task_94d8b4399a544349        exit 0   ← 什么都没停，记录被改成 canceled
修复后:  error: cannot cancel task_…: no live connection holds it, and a cancellation is
           only delivered over that connection. The agent may still be working — this task
           is NOT marked canceled, because doing so would be a lie.
         exit 1                                          ← 记录保持 working 不变
```

```
PASS  ACP handshake completed through the SSH path — agent=hermes-agent v0.21.3 protocol=1
PASS  the remote command is `cd <cwd> && exec env <K=V> <program>`
      — cd 'D:\工作' && exec env AGENTMESH_SSH_PROBE=mesh_probe_mu9v49qw '…\hermes-acp.exe'
PASS  a task completed over the SSH path — state=completed
      eventTypes=[task-created,task-state,log,usage,chunk,done]
PASS  approved edit took effect on disk — probe-approved-mu9v4m3d.txt: hello from agentmesh mu9v4m3d
```

真机那一份（`logs/lan-acceptance.txt`）的关键行：

```
node: nas-hermes (hermes/acp)  ssh user@10.0.0.5:2222
  ok   agent identified itself  hermes-agent 0.18.0
  ok   the bytes streamed back over ssh hash to the remote digest  4056397faf9130e3ad038da02ee97470
  ok   the artifact was (re)written by this run  8s old
  ok   this one was NOT auto-approved (an operator chose)  auto=undefined
  ok   the approved write took effect on the remote disk
35 passed, 0 failed
```
