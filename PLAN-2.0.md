# AgentMesh 2.0 规划 —— 内置技能与对等组网

> 版本 0.2 · 目标：让 AgentMesh **自己会干活**，并让多个 AgentMesh **互相认路、互相借能力**
> —— 但**借能力不等于给权限**。
>
> 本文是设计稿，尚未实现。1.x 的实现与验收见 [PLAN.md](PLAN.md) 与 [ACCEPTANCE.md](ACCEPTANCE.md)。

---

## 0. 一句话

1.x 的 AgentMesh 是一台**遥控器**：它只会把消息转发给别的机器上已经装好的 agent。
2.0 要做两件事：

1. **让 AgentMesh 自己成为一个能干活的 agent**（内置 File / Shell / Process / Service / Network 技能），
   于是**目标机器上什么都不用装**也能被派活。
2. **让两个装了 AgentMesh 的机器互相组网**：加一个对端 → 互相看到对方有什么技能 → 按权限调用。

这两件事必须一起做：一个只会转发、自己没有技能的对端，组起网来依然是空的。

---

## 1. 现状：2.0 的起点（已逐条核对代码）

| 事实 | 证据 |
|---|---|
| 控制面**只做出站**，没有任何入站能力 | `src/core/adapters/{a2a,acp,opencode,cli}.js` 四个适配器全是客户端 |
| AgentMesh **没有自己的 Agent Card 服务端** | `AGENT_CARD_PATHS` 只在 `src/protocol/a2a.js:45` 定义，唯一使用点是 `src/core/adapters/a2a.js:80` —— 抓别人的卡 |
| 编排 Agent 只有 6 个工具，**全是"派发"类，一个"自己动手"的都没有** | `AGENT_TOOLS` @ `src/core/orchestrator.js`：list_nodes / probe_node / send_task / broadcast / list_tasks / get_task |
| 节点模型是"叶子"：只描述**怎么连上别人**，不描述**我是什么、我能提供什么** | `NodeConfig` @ `src/core/registry.js` |
| 唯一的服务端是 Web 控制台，且它只服务人，不服务机器 | `src/web/server.js`（`/api/*` + console cookie） |

2.0 要补的三块：**技能（我能做什么）**、**对端（谁认识我、认识多少）**、**策略（允许谁让我做什么）**。

### 1.1 必须继承、不许削弱的既有安全性质

2.0 引入了"别人可以让我干活"这条新通路，它是整个项目里**第一个把攻击面引进来的功能**。
以下几件事是 1.x 已经做对的，2.0 只能加强：

- **审批是可寻址、可恢复的资源**，不是阻塞的 stdin（`approval` 表 + `input-required` 状态）。
  对端发来的"要不要执行"必须落进**同一条**通路，不能新造一套。
- **密钥永不落盘**：`quarantineSecrets()` / `runtimeNode()`（`src/core/registry.js`）把凭据挡在
  `nodes.json` 之外，`test/web.test.js` 用"密钥不出现在文件原始字节里"钉住它。对端 token 要遵守同一纪律。
- **离开 loopback 必须要有账号**，且**认证无法关闭**（`src/core/auth.js`，`createConsole` 拒绝无账号绑定公网）。
- **默认拒绝**：ACP client 默认不宣告 `fs`/`terminal`，审批默认 `deny`。

---

## 2. 目标结构

你给的结构是对的，我做两处调整：把"技能运行时"和"对端层"显式拆出来，并标出扩展点。

```
AgentMesh
├── Orchestrator              本机 LLM 循环 —— 唯一的"决策者"
│                              它只决定"派给谁 / 调什么"，不绕过任何策略
├── Skill Runtime             本机真正干活的执行器（2.0 新增）
│    ├── builtin  File / Shell / Process / Service / Network
│    ├── mcp      借 MCP server 的 tools（工具留在原处，只有调用过来）
│    ├── discovered  只读扫描 .claude/skills 等，仅用于广告与路由
│    └── plugin   ~/.agentmesh/skills/*.mjs  —— 第三方扩展点
├── External Agents           出站：让别人干活（1.x 已有，2.0 补元数据）
│    ├── Adapters: ACP / A2A / opencode / CLI
│    └── Claude Code · Gemini CLI · Hermes · OpenCode
└── Peer Layer                对等组网（2.0 新增）
     ├── Agent Card 服务端     /.well-known/agent-card.json —— "我有什么"
     ├── PeerHost 入站         /mesh/v1/* —— "你可以让我做什么"
     ├── PeerLink 出站         direct(HTTP) / hub(长连) / ssh
     └── Peer Policy           身份 · 可见性 · 授权 · 限额 · 审计
```

---

## 3. 模型设计

### 3.1 Skill 描述符（对齐 A2A AgentSkill，并加两个字段）

A2A 的 `AgentSkill` 已有的字段（`id / name / description / tags / examples / inputModes / outputModes`）
我们直接沿用 —— 这样内置技能可以**原样**出现在自己的 Agent Card 里，不用两套词汇
（`src/protocol/a2a.js:334` 已经在解析这套字段）。

```js
{
  id: 'file.read',
  name: '读取文件',
  description: '读取一个文本文件并返回内容',
  tags: ['file', 'read'],
  inputModes: ['application/json'],
  outputModes: ['text/plain'],

  // ——— AgentMesh 增加的两个字段 ———
  risk: 'read' | 'write' | 'exec' | 'service' | 'network',
  params: { /* JSON Schema，内置技能要能被 Orchestrator 当 tool 直接调用 */ },
}
```

`risk` 是 2.0 最关键的新字段：它把"我能做什么"变成**"我允许自己被要求做什么"的可判定依据**。
策略引擎只认 `risk` 和 `grant`，不认技能名字的字符串 —— 否则新增一个技能就是新增一个漏洞。

### 3.2 节点 vs 对端：两张表，两个方向

| | `NodeConfig`（已有，`nodes.json`） | `PeerConfig`（新增，`peers.json`） |
|---|---|---|
| 方向 | **出站**：我怎么连上别人 | **入站**：别人怎么连上我 |
| 内容 | transport / ssh / url / command / token | fingerprint / trust / advertise / grants / limits |
| 数量级 | 几十 | 几个 |

**刻意分成两个文件**：它们的信任方向相反，混在一张表里，迟早会有人写出一行
"遍历所有条目做鉴权"的代码 —— 而这行代码在方向相反的两类数据上必然写错。

```js
// PeerConfig
{
  id, name: 'nas',
  fingerprint: 'sha256:...',        // 配对时固定，之后变了就拒绝
  trust: 'blocked' | 'known' | 'trusted',
  advertise: {                      // 我让 TA 看到我什么
    skills: 'summary' | 'all' | ['file.read', 'file.search'],
    nodes: false,                   // 永远默认 false：不暴露内部节点清单与地址
  },
  grants: {                         // TA 能让我做什么
    'file.read':   { mode: 'allow', roots: ['/vol1/1000'] },
    'shell.run':   { mode: 'ask' },
    '*':           { mode: 'deny' }, // 通配兜底，显式写出来
  },
  limits: { rpm: 30, concurrent: 2, maxRuntimeMs: 60_000 },
  relay: false,                     // 2.0 固定 false，见 §3.3
}
```

### 3.3 三权分立 —— 这是回答"权限一定要控制好"的核心

你说的担心是对的，而且是我认为 2.0 最容易做错的地方。
业界的 mesh 系统出洞，绝大多数都是把下面三件事**混成了一个 `trusted` 布尔**：

| 概念 | 回答的问题 | 2.0 默认 |
|---|---|---|
| **可见性** | 你能**看到**我有什么 | 摘要（技能 id + 一句话）。**不暴露内部节点清单、地址、账号、传输方式** |
| **调用权** | 你能**让我做**什么 | 全部 `deny`；逐个技能显式开 |
| **身份** | 我凭什么相信你是你 | 配对时固定指纹；token 只用于建链，**不用于持久授权** |

三个推论，都要写死在实现里（并且每条都要有一个**否定测试**）：

1. **信任不对称。** A 信任 B ≠ B 信任 A。grant 是单向的，存在各自的 `peers.json` 里。
2. **不传递（no relay）。** A↔B、B↔C ⇒ **A 不能通过 B 摸到 C**。
   2.0 **不做中继**；Agent Card 里显式声明 `relay: false`，收到带 `origin` 的转发请求**直接拒**。
   这是我认为最容易出事的一处：一旦允许转发，B 上所有精心设计的 grant 都会被 A 用"我只是转发"绕过。
3. **降权转发 + 来源可辨。** 本机 Orchestrator 替用户下发的调用，和对端发来的调用，
   走**同一条** policy 检查代码；区别只在记录里标注来源（`peer:<id>` vs `local`）。
   并且 **Orchestrator 永远不能替对端审批** —— `mode: ask` 一定回到发起方的人类，不会被本机的 LLM 点掉。
   （否则对端只要说一句"我这是内部调用"，本机 agent 就会把 `shell.run` 批了。）

### 3.4 内置技能第一批（刻意做得少）

| 技能 | risk | 默认对本机 | 默认对 peer |
|---|---|---|---|
| `file.read` / `file.list` / `file.stat` / `file.search` | read | allow | allow（**限 roots**） |
| `file.write` | write | ask | deny |
| `shell.run` | exec | ask | **deny** |
| `process.list` | read | allow | deny |
| `process.start` / `process.kill` | exec | ask | deny |
| `service.status` | read | allow | deny |
| `service.restart` | service | ask | deny |
| `net.http` / `net.ping` / `net.port` | network | ask | deny |

为什么 `shell.run` 对 peer 默认 deny：**把 shell 暴露给对端，等价于给对端 SSH，却丢掉了 SSH 的边界与审计。**
要开必须显式 `mesh peer grant <peer> shell.run --mode ask`，而且每次都回到人类。

`file.*` 必须有 `roots`：所有路径先 `realpath` 再校验前缀，防 `..` 与**符号链接穿越**
（只做字符串前缀检查是最常见的漏洞写法）。

### 3.5 外部技能：三种接法，按"借到什么程度"排序

1. **委托**（1.x 已有，2.0 只补元数据）
   不改对方的技能，只是把它们**登记**进能力目录（如 `claude-code:code-review`），
   调用时整包交给那台机器的 external agent 执行。安全，现在就能做，是默认路径。
2. **MCP 工具借用**（新增）
   AgentMesh 作为 MCP client 连上一个 MCP server，把它的 tools 变成 skills。
   **工具留在原处，只有调用过来。** 这与 1.x PLAN.md §2 第 7 条结论一致（MCP 只用来给 agent 挂工具）。
3. **技能文件发现**（新增，**只读**）
   扫 `.claude/skills/*/SKILL.md`、`.opencode/`、Hermes skills 目录，读 frontmatter 得到 id 与描述，
   **只用于广告与路由，绝不复制执行**。
4. **（2.0 明确不做）** 把别人的技能代码下载到本地执行。需要签名、沙箱、依赖隔离 —— 那是 3.0 的题目。

> 说清楚一件事：1–3 都是"**我知道你有这个技能，我把活派给你**"，
> 而不是"我把你的技能拿到我这来跑"。这个区分决定了 2.0 的安全边界在哪。

### 3.6 组网：三条路，统一抽象、按可达到性选

- **A. direct（直连）** — 对端跑 `mesh serve --peer`，暴露 `/.well-known/agent-card.json` 与 `/mesh/v1/rpc`。
  本机 `mesh peer add <url> --token ...` 即建立。**最简单，M2 先跑通这条。**
- **B. hub（出站长连，零入站端口）** — Hub 是唯一有端口的机器；各 spoke 出站连上 hub 并保持长连。
  **继承 1.x "远端零入站端口"的性质**，且能穿 NAT。代价：hub 是单点，也是信任焦点。
- **C. ssh** — 既没有 HTTP 也没有 hub 时，退回 1.x 的 stdio-over-SSH，把对端当 ACP agent 用
  （对端启一个 `mesh acp` 门面，把 `skills.invoke` 映射成 ACP 的一次会话）。

统一抽象：`PeerLink`（出站）+ `PeerHost`（入站），三条路是它的三个实现。
**上层的 policy / skill / audit 完全不知道走的是哪条** —— 这是三条路能共存的唯一前提。

**局域网自动发现（"自动组网"的落点）**：`mesh peer discover` 用 `node:dgram` UDP 广播 beacon
（零依赖，符合项目"不用 npm 包"的底线），只广播**最小卡**（名字 + 协议版本 + "需要配对"），
**不广播 token、不广播技能细节、不广播节点清单**。
发现之后仍然是**人工确认 + 配对**：自动信任意味着"谁在这个网段里谁就能 RCE"，这条路不能走。

### 3.7 配对流程

```
A: mesh peer add 192.168.1.5:7331 --name nas
   → 出站 GET /.well-known/agent-card.json（未认证，只返回最小卡）
   → 打印对端指纹 + 6 位配对码（带 TTL，只在本机显示）
B: mesh peer accept <code>          # 必须在 B 上用 console 账号确认
   → 双方交换长期 token，写入各自 peers.json（0600）
A/B: mesh peer list                 # 互见；grants 全默认 deny
```

凭证纪律沿用 `registry.js`：**对端 token 明文只存在节点侧 0600 文件里，或只存环境变量名**，
与 `quarantineSecrets()` 同一套规矩；**Web 控制台永远拿不到对端 token**
（复用 `test/web.test.js` 已有的"密钥不出现在文件原始字节里"断言，2.0 加 peer 版本）。

### 3.8 一次跨机技能调用的完整路径

```
A 的 Orchestrator: invoke_skill(peer='nas', skill='file.search', args={...})
  └─ A 侧策略：我允不允许我自己去用别人？（默认允许，但记审计：谁、何时、用了什么）
      └─ A→B: /mesh/v1/skills.invoke  + 身份 + origin=A
          └─ B 的 PeerHost：
               1. 认证     token / 指纹（不匹配直接 401，且不计入 "known"）
               2. 可见性   这个技能我对 TA 广告过吗？          → 没广告 = 404（不是 403，不确认存在性）
               3. 授权     grant[sid].mode = allow | ask | deny
               4. ask  → 落库成 approval，回 A，任务转 input-required
                          （复用 1.x 审批通路：mesh approve / Web 按钮）
               5. 执行     scope 校验（roots / allowlist / timeout / 并发 / rpm）
               6. 审计     落事件：peerId, skillId, args 摘要, 结果摘要, 时长, 决策
  └─ 结果原样回 A，A 的编排器原样带回用户
```

注意第 2 步的细节：**没广告的技能要返回 404 而不是 403** —— 403 等于告诉对方"这个技能存在但你不能用"，
那就是一台免费的能力扫描器。

---

## 4. 代码落点（尽量不动已有结构）

```
src/skills/
  descriptor.js    技能描述符 + risk + 参数校验
  registry.js      SkillRegistry：注册 / 查找 / 按 risk 过滤 / 生成 A2A AgentSkill
  builtin/  file.js  shell.js  process.js  service.js  network.js
  mcp.js           MCP client provider（可选启用）
  discover.js      扫描 .claude/skills 等，只读登记
  plugin.js        ~/.agentmesh/skills/*.mjs 动态加载  ← 第三方扩展点
src/peers/
  card.js          生成 / 签名 / 校验自己的 Agent Card
  policy.js        PeerConfig + grants 判定（纯函数，好测）
  pairing.js       配对码 / 指纹 / token
  link.js          出站 PeerLink（direct / hub / ssh）
  host.js          入站 PeerHost
  discover.js      UDP beacon
```

改动面（都是加法）：

| 文件 | 改动 |
|---|---|
| `src/core/orchestrator.js` | `AGENT_TOOLS` 增加 `list_skills` / `invoke_skill`；system prompt 注入技能清单 |
| `src/core/registry.js` | 不动；新增独立的 peers 存储 |
| `src/web/server.js` | 新增 `/.well-known/agent-card.json`、`/mesh/v1/*`，走 **peer token**，与 console cookie **互不相通** |
| `src/protocol/events.js` | 新增 `skill-invoked` / `peer-called`（`test/ui-events.test.js` 会强制渲染层跟上） |
| CLI | 新增 `mesh skill ...` 与 `mesh peer ...` 两组命令 |

扩展点（写给未来的贡献者）：
`SkillProvider`（`{ id, listSkills(), invoke(id, args, ctx) }`）、
`AgentAdapter`（把现有四个适配器形式上接口化，加 `registerAdapter(kind, factory)`）、
`PeerTransport`（link/host 三实现）、以及 `~/.agentmesh/skills/*.mjs` 这个**免编译插件目录**。

---

## 5. 里程碑

| | 内容 | 产出 |
|---|---|---|
| **M1** | 技能内核 + 内置技能 | `mesh skill list/run`；本机能干活；自己的 Agent Card 能生成 |
| **M2** | 对等组网 + 配对 + 策略（direct 直连） | `mesh peer add/list/show/remove/accept`；A 调用 B 的 `file.read` 跑通 |
| **M3** | 安全加固 | grant / 审计 / 限额；**否定测试**：不可传递、越权、路径穿越、伪造指纹 |
| **M4** | 外部技能 | 委托元数据、MCP 借用、只读发现 |
| **M5** | Orchestrator & 控制台 2.0 | 统一库存、Peer 页面、审批来源标注 |
| **M6** | hub 模式（零入站端口长连） | 视 M2 结果决定是否提前 |

M1 与 M2 建议一起做完再对外说"2.0"：只做 M1 是"能干活但孤立"，只做 M2 是"能连但没东西可借"。

---

## 6. 不做什么（写下来防止范围失控）

- ❌ 技能代码的远程分发与执行（→ 3.0，需要签名 + 沙箱）
- ❌ 中继 / 多跳转发（安全上无法证明，2.0 明确拒绝）
- ❌ 局域网自动信任 / 自动配对（发现可以自动，信任必须人工）
- ❌ 自有推理模型、模型路由（沿用 1.x 的边界）
- ❌ 技能市场、评分、签名体系

---

## 7. 待拍板

见文末对话中的四个问题：组网拓扑、对端默认可见性、执行类技能的默认授权、实施顺序。
