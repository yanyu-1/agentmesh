# 参与 AgentMesh 开发

感谢你愿意花时间。这份文档的目标是让你**在 10 分钟内改出第一个能合并的 PR**，并且不踩这个项目特有的坑。

> English speakers: the project's docs are Chinese-first. Issues and PRs in English are welcome — we would rather read a clear English report than lose it. Ask if anything below is unclear.

---

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 22.5** | 项目用了内置 `node:sqlite`。开发时用的是 v24.16 |
| npm 依赖 | **无，且不打算有** | 见下方「零依赖是一条硬约束」 |
| 操作系统 | Windows / Linux / macOS 均可 | 主开发机是 Windows，CI 跑 Linux |

```bash
git clone https://github.com/yanyu-1/agentmesh.git
cd agentmesh
npm test          # 不需要 npm install，因为没有依赖
```

---

## 2. 零依赖是一条硬约束

`package.json` 里 `dependencies` 与 `devDependencies` 都是空的，这是**设计决定，不是还没加**：

- 控制面要能直接拷到一台只有 Node 的服务器上跑起来；
- 供应链攻击面为零；
- 所有行为都能在 `src/` 里读到源码，没有黑盒。

**因此：新增任何一个运行时依赖的 PR 都会被拒绝**，除非你在 issue 里先论证清楚为什么内置模块做不到。测试与构建工具同理——优先用 `node:test` 和 `node:` 前缀的内置模块。

---

## 3. 跑测试

```bash
npm test                 # 完整链路（18 个文件，217 个用例）
npm run test:runner      # node --test test/（自动发现，开发时更快）
node --test test/args.test.js   # 单跑一个文件
npm run check:docs       # 跨文档计数/链接/缺陷表一致性
npm run check:ui         # Web 控制台的 DOM 自检
```

**合并要求：`npm test` 与 `npm run check:docs` 都必须全绿。**

### 关于被跳过的用例

`npm test` 里可能有几个用例显示 `skipped`，附带的说明形如
`cannot spawn a child with piped stdio here (spawn EPERM)`。那是受限执行环境里的**预期行为**——
用例自己检测到环境不允许派生子进程，于是诚实地跳过并说明原因，而不是伪装通过。在你自己的机器上它们会正常执行。

### `tools/verify-*.mjs` 不进 CI

这些脚本要连**真实**的 SSH 主机、真实的 ACP/A2A 对端，CI 里没有这样的机器，所以它们只在你手上跑：

```bash
node tools/verify-lan.mjs --node <节点名> --dir /srv/work --log logs/lan-acceptance.txt
```

跑完的结果记录在 `logs/`（已 gitignore，含真实主机信息，**不要提交**）。

---

## 4. 文档必须跟着代码一起改

这是本项目最容易让 PR 卡住的地方。`README.md`、`USAGE.md`、`ACCEPTANCE.md` 里有**互相引用的数字**
（测试文件数、用例数、通过数、跳过数、缺陷表行数）。它们一旦漂移，`npm run check:docs` 会失败并指出哪一份不一致。

所以：

- 加了一个 `test/*.test.js` → 必须同时加进 `package.json` 的 `test` 链，并更新三份文档里的计数；
- 改了一条命令的行为 → `USAGE.md` 里对应的示例要跟着改；
- 修了一个缺陷 → 在 `ACCEPTANCE.md` 的缺陷表**追加一行**（不要改写历史行）。

不确定要改哪些？先跑 `npm run check:docs`，它会直接告诉你不一致在哪。

---

## 5. 代码风格

没有 linter，靠约定和评审：

- **ESM**（`"type": "module"`），`import` 时带 `.js` 后缀；
- 2 空格缩进，单引号，语句结尾加分号；
- 注释解释**为什么**，不解释**是什么**——代码已经说明是什么了；
- 面向操作员的输出用中文（本项目的用户界面语言），代码、变量名、提交信息用英文。

---

## 6. 提交信息

用 Conventional Commits 的形状，描述用英文，一句话说清改了什么：

```
fix(net): retry listen when the OS hands out a fetch-blocked port
feat(cli): add `mesh secrets set --stdin`
docs(usage): correct the batch-mode explanation
```

正文里如果修复的是一个具体缺陷，**请说明你是怎么复现它的**——只写"修复了 X"的 PR 没法评审。

---

## 7. 这个项目最看重什么

读一遍 `ACCEPTANCE.md` 的缺陷表（62 条），你会发现它们几乎都是同一类：

> **看起来成功、实际做反了。**

比如一条错误提示指向"网络不通"而真实原因是"表单缺字段"；比如 `--token` 缺值时被解析成布尔 `true`
并被静默写进注册表。这类缺陷比崩溃更危险，因为它训练人去相信一个假的绿灯。

因此评审时的第一标准是：

1. **失败要失败得诚实。** 宁可报"没有可用密码"，也不要拿一个错的密码去试。宁可跳过并说明原因，也不要伪装通过。
2. **两条入口必须说同一件事。** CLI、Web、文档三者对同一操作的描述要一致——本项目反复出现"界面能建、命令行建不出"的缺陷。
3. **不要凭记忆写常量。** 端口黑名单、协议字段这类东西要**实测**出来并在注释里留下实测方法。

如果你的 PR 触及这三点，请在描述里主动说明你是怎么验证的。

---

## 8. 想加一个新的适配器 / 节点类型？

这是最有价值的贡献，但**改动面比看起来大**。请务必同时动这些地方（缺陷表第 36 条记录了只改一半的后果）：

1. `src/core/adapters/<name>.js` —— 适配器本体；
2. `src/core/registry.js` —— 节点字段与校验；
3. `src/cli/args.js` —— CLI 参数映射，并在 `main.js` 里接上；
4. `src/web/ui.html` —— 控制台表单字段（**不要只加主机名一个框**）；
5. `src/core/fleet.js` —— 分派路径；
6. `test/<name>-adapter.test.js` —— 至少覆盖成功、失败、审批、会话续接四条路径；
7. `README.md` / `USAGE.md` —— 适配器表格与用法。

先开一个 issue 说清你要接的协议和它的传输方式，我们可以先对齐设计再动手，省得白写。

---

## 9. PR 流程

1. Fork 并从 `main` 开一个分支（`feat/xxx` / `fix/xxx`）；
2. 改动 + 测试 + 文档一起提交；
3. 确认 `npm test` 和 `npm run check:docs` 全绿；
4. 提 PR，描述里写清：**改了什么、为什么、怎么验证的**；
5. 涉及真实主机才能验证的部分，请贴出你实际跑的命令和输出。

CI 会在 Linux 上跑 `npm test` 与 `check:docs`。真机相关的验证不会在 CI 里跑，所以那部分靠你自己贴证据。

---

## 10. 安全

**不要在 issue / PR / 截图里贴真实的密码、token、主机地址或私钥。** 报告安全问题的正确渠道见 [`SECURITY.md`](SECURITY.md)。

提交前请自查一遍：

```bash
git diff --cached | Select-String -Pattern 'password|token|BEGIN.*PRIVATE KEY'
```

---

## 许可

贡献即表示你同意以 [MIT License](LICENSE) 授权你的贡献。
