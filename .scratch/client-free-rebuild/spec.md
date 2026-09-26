# Spec: 纯宿主插件重建（移除浏览器半边）

Status: in_progress（P0–P1 完成）
Type: task
Created: 2026-09-26
Supersedes: `.scratch/dsh-0.1.7-desktop/spec.md`（那份的接入与兼容轮已经落地；本文件是**重建**的依据）

## 1. 目标

把本项目重建为**纯宿主 bundle**：不携带任何浏览器半边，只以插件方式进入 DSH。
登录、额度、计量这些原先靠自带 UI 的能力，全部改由 **DSH 原生面 + agent 工具 + rescue CLI** 承载。

## 2. 为什么（根因，不是偏好）

DSH 0.1.7 里，一个**导入失败的客户端 entry 是致命的 web 启动错误**：

```
Error: web boot: 1 entry did not activate
dsh-provider-openai-subscription: import failed (see console for the import error)
    at resources/app.asar/lib/main.js
```

Desktop 外壳把它当 fatal recovery：崩溃并自动重启（2026-09-26 实测，崩溃报告
`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-2026-09-26T10-23-32-086Z-web-boot.log`）。
触发条件只是"客户端文件在运行中被改动"。只要还带客户端，这条路就一直存在。

## 3. 硬约束（机器可判定）

| 约束 | 判定 |
|---|---|
| 无 `dsh.client` | `package.json` 字段不存在 |
| 无 `exports["./client"]` | exports 映射不存在 |
| 无 `client/` | 目录不存在，`files` 白名单不含 |
| 无浏览器模块握手 | 仓库内 `__ModuleLoader__` 零命中 |
| 首页无痕 | 真实 `dsh web` 首页不含本包名/预加载/bundle 行 |

以上全部由 `test/no-client.test.mjs` 与 `scripts/web-smoke.mjs` 看守。

## 4. 决策（2026-09-26，按建议执行）

| # | 决策 | 采取 |
|---|---|---|
| D1 | 内置用量计量 | 保留并工具化（纯宿主侧、零依赖、已测；**界面消失**） |
| D2 | 登录入口 | 工具 + CLI 双入口 |
| D3 | HTTP 路由 | 只留 OAuth 回调所需最小路径，其余删除 |
| D4 | provider id / 凭据键 / 配置字段 | 全部沿用（`openai-subscription`、`llm-openai-subscription/default`） |
| D5 | 版本与仓库 | 同仓重构，破坏性变更 → 2.0.0 |
| D6 | 现网处置 | 先卸载 Desktop 里那份，再重构 |
| — | 不修改客户端 | **绝对约束**：不是"少改"，而是"不存在" |

## 5. 目标架构

```
src/           宿主半边（provider / credentials / oauth / balance / models / usage）
src/tools/     ★ 新增：status / login / logout / quota / meter
src/web/       收窄到 OAuth 回调
src/rescue.mjs 无 UI 时代的主运维入口
cordis.patch.yml  bundle 补丁层（唯一保留的对外声明）
```

对外可见的一切只来自：DSH 原生模型页、agent 工具、rescue CLI、日志。

## 6. 能力搬迁

| 旧（依赖客户端） | 新承载 |
|---|---|
| 设置页 Provider 卡片 | `llm.registerConfigurableProviders` → 原生模型页一行 |
| 设置页「刷新模型」 | `llm.registerModelDiscovery` |
| 三种登录 | `ctx.authorization.registerFlow`（oauth / manual / device）+ 工具/CLI 触发 |
| 侧边栏指示器、用量卡片、首次引导、自带设置页 | **删除**；额度与计量改由工具/CLI |
| 22 条本地路由 | 只留回调 |

**已知缺口（P3 需 spike）**：全量 grep 证明 DSH 0.1.7 的**任何客户端都没有调用 `authorization/*`**，
`settings.models.sign-in` 插槽由账号插件占用走 Platform 自己的 remote。因此注册 flow 只是
"可被授权"，**现成 UI 里没有按钮**——入口必须由工具/CLI 提供。

**已知缺口（P2 需 spike）**：原生「设置 → 模型」页对第三方 `settingsNs` 是否给可编辑表单，
还是只给一行（现成编辑器可能只认 deepseek / pi-ai 两个 family）。退路：配置只走 profile patch 层。

## 7. 阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 冻结基线（tag `v1.5.0-pre-rebuild`）、决策入档 | ✅ |
| P1 | 剥离客户端：删 `client/`、`dsh.client`、`exports`、`files`；删 7 个客户端测试；`doctor` 改为断言"无客户端"；web 门禁反向；新增守卫测试 | ✅ |
| P2 | 原生配置面（含 spike S1） | 待办 |
| P3 | 登录路径（含 spike S2） | 待办 |
| P4 | 计量与额度的工具化/CLI 化 | 待办 |
| P5 | 路由收口 | 待办 |
| P6 | 门禁重建 | 待办 |
| P7 | 发布 2.0.0 | 待办 |

## 8. 验收（最终）

1. 仓库：`no-client` 守卫与反向 web 门禁全绿。
2. `npm run test:release` 在真 0.1.7-rc.2 上 exit 0。
3. Desktop：模型页出现该 provider；工具完成一次真实登录；跑通一轮真实对话。
4. 额度/计量：工具或 CLI 能读出数字。
5. 刷新/重启/`dsh web` 首页均无本插件痕迹，无 web boot 失败。
6. 卸载演练：卸载 → 重启 → profile 正常，凭据与账本保留。

## 9. 风险

| # | 风险 | 对策 |
|---|---|---|
| R1 | 没有侧边栏后"额度看不见" | 工具 `quota` + CLI；不默认新增提示注入 |
| R2 | 原生模型页不认第三方 namespace | 配置只走 patch + `rescue config` 打印可粘贴片段 |
| R3 | 授权 flow 无原生按钮 | 工具/CLI 触发；交互仍在 DSH 原生 prompt |
| R4 | 客户端被重新引入 | `test/no-client.test.mjs` 直接 FAIL |
| R5 | 重构期与现网同名同 id | D6：已从 Desktop 卸载并清理残留（依赖/bundle/patch 行/junction） |

## Comments

- 2026-09-26 建档。P0+P1 已完成：仓库 385 单测全绿，反向 web 门禁 PASS。
  现网（Desktop profile）已按 D6 退出：`plugin_manager remove_bundle` + 删除 profile patch 里的激活块 +
  清理 `node_modules` 里残留的 junction；实测 GUI 未崩，客户端席位列表里已无本插件注册。
