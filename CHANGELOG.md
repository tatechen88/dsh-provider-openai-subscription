# CHANGELOG

本文件记录值得让使用者知道的变化。更早的版本看 git tag（`v1.5.0` 及以前）。

## 2.0.0 — 纯宿主插件

**破坏性变更：插件不再带任何浏览器界面。** 这不是精简，是修根因。

### 为什么

DSH 0.1.7 把「客户端 entry 导入失败」当**致命的 web 启动错误**：

```
Error: web boot: 1 entry did not activate
dsh-provider-openai-subscription: import failed (see console for the import error)
```

Desktop 外壳据此判定 fatal recovery，**崩溃并自动重启**。触发它只需要在运行中的实例上改一次客户端文件
（本项目实测发生过一次）。结论不是"小心地改客户端"，而是**不存在客户端**。

### 移除

- `client/`（2587 行的浏览器半边）、`dsh.client` 声明、`exports["./client"]`。
- 侧边栏额度指示器、悬浮用量卡片、会话用量行、首次引导、自带设置页。
- 21 条 HTTP 路由（`/meter/*`、`/oauth/*` 的浏览器驱动、`/models`、`/balance`、`/migration/backup`…）。
- 凭据迁移的加密备份流程（它唯一入口是设置页对话框；而旧记录本插件从不改动或删除，副本并不承担"保命"作用）。

### 新增

- **agent 工具**：`openai_subscription_login` / `_status` / `_logout` / `_quota`、`usage_meter_report`。
  登录默认给一条浏览器链接，也支持设备码；有界等待**不取消**尝试，超时后可用 status 续看。
- **DSH 原生授权流程**：`ctx.authorization.registerFlow`（`oauth` / `manual` / `device` 三种 method）。
  任何能驱动该 seam 的界面都能发起登录，插件不需要为它写界面。
- **原生可发现性**：`llm.registerConfigurableProviders` + 一个可投影的 Config schema（宿主自带 schemastery 时使用，
  否则回退内置 Standard Schema），于是插件出现在 **设置 → 模型** 页里，未登录时也可见。
- `provider.defaultModel` / `provider.reasoningEffort` 标为 volatile：改动被运行中的插件直接采用，不用重启。
- 一条只读的 `GET /plugins/openai-subscription/status`（带部署栅栏），供运维 `curl`。

### 保留但改了入口

- 流式输出、token 用量上报、模型目录与自动刷新、新模型观测、账本与计价、额度读取、冲突检测、kill switch、
  Rescue CLI 的 doctor / snapshot / rollback 全部保留；额度与用量改由工具按需报告。

### 测试与验证

- `test/no-client.test.mjs`：声明、导出、发布文件、目录、`__ModuleLoader__` 五道检查，阻止浏览器半边回来。
- `test:web` 反向：断言 `dsh web` 首页**不含**本插件的任何痕迹，同时从服务端证明宿主半边确实挂载。
- 组合门禁新增：真实 `AuthorizationService` 驱动本插件的 flow；真实 `defineTool` 接受并执行全部工具定义。
- 工具结果统一过 lossless 边界（`src/lossless.js`）：`usage_meter_report` 首次对着真实账本运行时报
  `value is not lossless JSON` —— 投影从视图顶层读了实际位于 `pricing` 下的字段，于是三个字段是 `undefined`，
  而带 `undefined` 的工具结果会被宿主整场拒绝。现在既修了读取层级，也在边界上兜底。

### 安装或升级后必须重启进程

模块图是缓存的：**插件开关能重建条目，但改过的 `operations.js` 仍按旧代码运行**；
HMR 触发的重新应用更差——它不带声明的 `inject`，会**静默丢掉工具**。所以升级后请重启 DSH Desktop。

### 升级注意

- 已安装的 profile 需要**重启**；重启后不会再有侧边栏/设置页入口。
- 凭据键、设置命名空间、Provider ID 与前一条线**完全一致**，已登录的凭据与已有配置继续有效。
- 配置仍在 `cordis.patch.yml` 的 `llm-openai-subscription` 段。
