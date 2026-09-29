# CHANGELOG

本文件记录值得让使用者知道的变化。更早的版本看 git tag（`v1.5.0` 及以前）。

## 2.1.0 — 回调端口可配置：把「写死的 1455」变成 `oauth.callbackPort`

### 修复：Windows 端口保留段让 OAuth 登录根本无法开始

**现象**（2026-09-29 实测）：`openai_subscription_login` 的 `oauth` 方式直接报
`OAuth callback port 1455 is unavailable on IPv4`（`CallbackServerError: ipv4-unavailable`），
而 `netstat` / `Get-NetTCPConnection` 里**没有任何进程占用 1455**。改用 device flow 能登录，
所以问题不在凭据、不在上游。

**根因**：Windows 上 Hyper-V / WSL / Docker 会**动态预留**成段的端口，
落在段里的端口对任何进程都是不可绑的——报 `EACCES`（不是 `EADDRINUSE`），
占用者查询因此永远查不到。本机实测保留段 `1437-1536`，`1455` 正在其中；
逐端口实测 `1537` 是其后第一个可用端口。**该范围随重启漂移**（本机 2026-09-20 那次是 `8348-8447`）。

**变更**：

- 新增配置 `oauth.callbackPort`（**非 volatile**，默认 **1455**，整数 1–65535）：
  此前回调端口在 `attempt-manager.js` 里硬编码 `port = 1455`，配置面只有 `oauth.clientId`。
  默认值不变，所以什么都不写的 profile 与从前**完全一致**。
- **刻意不接受 `0`**（虽然 `startCallbackServer` 支持）：redirect_uri 必须在打开浏览器之前
  就已知，让操作系统随机挑端口等于回调永远进不来。畸形值（0、负数、小数、超范围、非数字）
  **回退默认而不是钳制**——静默改写运维者声明的端口比忽略它更糟。
- **端口不可绑时明确失败，绝不换端口**：自动回退会把浏览器送到一个运维者从未配置过的
  redirect_uri，那正是本选项要避免的失败；错误信息里点名端口。
- Standard Schema 回退与 schemastery 两套 schema 同步校验；写错类型照旧在加载前点名。
- README 配置表与「登录点了链接但没登录」排查段同步更新（含 `netsh int ipv4 show excludedportrange protocol=tcp`）。

**注意**：宿主半边改动，**需重启 DSH Desktop** 才加载本版（junction 安装，源码即产物）。
`inject` 只在创建条目时读取，改 `callbackPort` 后运行中的进程不会采用新值。

**测试**：424/424 通过（`npm run test`；原 419 + 新增 5 条，覆盖默认值、透传、
畸形回退、字面端口进 redirect_uri、以及"不可绑时不替换端口"）。

## 2.0.2 — 流超时可配置：把「120 秒硬上限」变成 `provider.streamTimeoutMs`

### 修复：上游拥堵时正在生成的流被静默掐断

**现象**（2026-09-27 夜间实测）：`chatgpt.com` 的 codex/responses 端点变慢，
单次响应 60–120 秒以上；一旦超过适配器**硬编码的 120 秒总超时**，`controller.abort()`
把正在生成的 SSE 流直接掐掉，整轮对话以 `"This operation was aborted"` 结束。
成功调用（10–119.5 秒）照常留痕，失败调用不写 usage 计量——于是"计量全绿但一直失败"，
极具误导性。配额与登录态全程正常（主窗口用量 5%）。

**变更**：

- 新增配置 `provider.streamTimeoutMs`（volatile，默认 **300000**，范围 1000–600000）：
  一次模型调用的整体 deadline——响应头 + 整个 SSE 流（旧版在响应头到达时也不清计时器，
  即超时从来就是覆盖全程的，只是上限写死）。
- 适配器默认 `timeoutMs` 120 秒 → 300 秒；`setDefaults` 会采纳运行期修改，
  设置表单里改完立即生效，不用重启。
- `normalizeConfig` 对畸形/低于下限的值回退默认（不钳制——见 `MIN_STREAM_TIMEOUT_MS` 注释）；
  Standard Schema 回退对新字段做类型校验，写错类型照旧在加载前点名。
- README 配置表与 volatile 清单同步更新（"唯二"→"仅有的三个"）。

**注意**：宿主半边改动，**需重启 DSH Desktop** 才加载本版（junction 安装，源码即产物）。

## 2.0.1 — 双语 + 严格审查修复

### 新增：跟随当前语言（中文 / English）

工具描述、错误文案、登录提示、路由错误会跟随当前语言：优先读 DSH 的语言偏好
（设置 → 通用 → Language），退回进程/系统语言，最后英文。机器值（JSON 字段、错误 `code`、模型 id）保持英文。
生效时机是**下一次激活**（工具描述注册后不能原地改词）；当前语言记录在运行时记录的 `language` 字段。

**插件页卡片**走 DSH 的 `locale/<lang>.json` 约定（`meta.title` / `meta.description`，与内置 bundle 一致）：
新增 `locale/en.json`、`locale/zh.json`，并把 `"./locale/*.json"` 加进 `exports`——
少了这一条，Node 会以 `ERR_PACKAGE_PATH_NOT_EXPORTED` 拒绝解析，DSH 读成"没有元数据"而回落到英文清单文案
（这正是卡片一直显示英文的原因）。另加 `icon.svg` 作为插件页图标。注意：0.1.7 的 Desktop 组合里插件页
目前不投影这份 `meta`（DSH 自带本地化 bundle 同样如此），该修复要等宿主侧接通才可见。

### 修复（独立审查发现，全部已验证）

- **被吊销的 refresh token 不再无限重试**：token 端点自己的 `invalid_grant`（此前只藏在错误消息文本里）
  现在随错误带上 `oauthError` 字段，token manager 据此落 `needsReauth`；瞬时错误（超时、5xx）仍然可重试。
- **停用插件后运行时记录不再"看起来还活着"**：记录写入改为**串行队列 + 每次写入独立临时文件**，
  拆卸期未 await 的写入不再与 `stoppedAt` 写入交错或反序落盘。
- **一次杂散请求不再杀死等待中的登录**：错误 state 的回调探测（预取、扫描器、别的进程的旧标签页）
  只会得到 400，登录继续等待；只有 state 匹配的真实回调才能结算。
- **SSE 流现在也受超时约束**：此前超时在响应头到达时就被清除，中途停滞的流会挂到消费者放弃为止；
  现在读循环结束时才清计时器，且消费者提前离开时会 `reader.cancel()` 关闭上游连接。
- **登录工具的结果也过 lossless 边界**（五个工具里此前唯独它没包，一旦带 `undefined` 字段整场调用失败）。
- **CLI**：`rollback` 的并发保护标记真正写入/清除；`canary` 的输出不再指向一个随即被删除的目录；
  `status` 的快照计数改读快照子目录（此前把运行时记录和计量设置也算成快照）。
- **OAuth attempt 结算后会在下一次登录时清理**（不再无限累积），两个管理器同时挂起时取**较新**的那个。
- **token 端点的响应体读取也受超时约束**（此前只有请求阶段受限）。
- **模型目录的 TTL 从拉取完成时刻起算**（此前慢拉取会烧掉自己的缓存时长）。

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
