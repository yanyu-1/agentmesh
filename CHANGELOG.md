# 更新日志

本项目的所有重要变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **关于 0.1.x：** 项目处于早期阶段，`0.x` 之间可能存在不兼容变更。
> 每次破坏性变更都会在此文件中明确标注。

---

## [Unreleased]

### 新增

- Web 控制台、CLI、A2A/ACP/opencode/CLI 四类适配器；
- 跨机器任务派发、实时事件流（SSE，支持 `?after=<seq>` 续传）、会话续接；
- 可落盘、可恢复的审批资源（`input-required` + `mesh approve`）；
- `mesh secrets`：凭据存于 `~/.agentmesh/secrets.env`（`0600`，明文），节点只保存变量名；
- `AGENTMESH_HOME` 支持把控制面状态放到任意目录。

### 面向开源的准备（本次）

- 新增 `CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、Issue/PR 模板与 CI；
- **文档脱敏**：`README.md` / `USAGE.md` / `ACCEPTANCE.md` 中的示例主机地址、SSH 端口、账号名、
  工具链路径全部替换为通用示例值（`10.0.0.5` / `2222` / `user` / `D:\工作` 等）；
- `.gitignore` 排除 `research/`（约 58 MB 第三方语料，可再生）与 `*.agentmesh-sec/`（本地运行时状态）；
- 修正 `tools/check-docs.mjs`：`logs/` 属于生成物且不随仓库分发，全新克隆下不再误报缺失；
- 修正 `test/opencode-adapter.test.js`：断言改为即时派生 URL 编码，不再硬编码某一个目录名的编码结果
  （原写法把测试钉死在一个具体路径上，示例路径一改就误报）。

### 已知限制

- **Web 控制台没有认证**，仅应绑定回环地址。详见 [`SECURITY.md`](SECURITY.md)；
- `secrets.env` 是明文，保护来自文件权限而非加密。生产环境建议改用 SSH 密钥；
- 尚未验证项（密钥认证等）逐条列在 [`ACCEPTANCE.md`](ACCEPTANCE.md) 的「未验证项」一节。

[Unreleased]: https://github.com/yanyu-1/agentmesh/commits/main
