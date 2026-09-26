# Spec: 纯宿主插件重建（移除浏览器半边）

Status: done（P0–P7 完成，2.0.0 已发布）**＋ 一条未决项（P8，见文末）**
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
| D2 | 登录入口 | 工具 + CLI 双入口 → **修订为：工具 + authorization flow**（理由见下） |
| D3 | HTTP 路由 | 只留 OAuth 回调所需最小路径，其余删除 |
| D4 | provider id / 凭据键 / 配置字段 | 全部沿用（`openai-subscription`、`llm-openai-subscription/default`） |
| D5 | 版本与仓库 | 同仓重构，破坏性变更 → 2.0.0 |
| D6 | 现网处置 | 先卸载 Desktop 里那份，再重构 |
| — | 不修改客户端 | **绝对约束**：不是"少改"，而是"不存在" |

## 5. 目标架构```
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
| 三种登录 | `ctx.authorization.registerFlow`（oauth / manual / device）+ 工具触发 |
| 侧边栏指示器、用量卡片、首次引导、自带设置页 | **删除**；额度与计量改由工具/CLI |
| 22 条本地路由 | 只留回调 |

### P3 结果（2026-09-26 实测，真 seam 驱动）

- `src/oauth/authorization-flow.js`：flow 只做编排——启动现有 attempt、用 `session.notify` 说人话、
  需要时才 `session.prompt`，并在**授权写入由 attempt 自己经 `ctx.credentials` 完成**后 resolve。
  seam 的 `observed.committed` 正是监听 `credentials/record-updated`，所以不需要 `session.commit`
  （调用它反而会写两次）。**已实测**：真 `AuthorizationService` 下 `begin({method:'manual'})` 走到
  我们的 flow、prompt 送达 interaction、state 不匹配的回调被拒且 `inFlight` 回落为 false。
- `src/operations.js`：工具/flow 共用的唯一实现（status / login / logout / cancelLogin）。
  `login` 的有界等待**不取消**尝试（"我不等了" ≠ "我改主意"），取消是独立动作。
- `src/tools.js`：`openai_subscription_status|login|logout`。定义交给**宿主自己的** `defineTool`
  （经共享锚点懒加载；取不到就不注册工具，不阻塞激活）。**已实测**：真 helper 接受全部 3 个定义并能执行。
- 接线：服务**在场就直接注册**，缺席才 `ctx.inject`。这一点是被真机门禁逼出来的——服务已存在时
  `ctx.inject` 会同步回调一个尚未激活的 scope，在其上建 effect 会抛 `INACTIVE_EFFECT`，
  于是整个插件激活失败（旧写法在 smoke 里一直被 try/catch 吞掉才没暴露）。

**D2 修订**：CLI **不做登录**。凭据只能经 `ctx.credentials` seam 写入，而这个 plugin 明确承诺
"绝不绕过 DSH 直接碰 `.credentials.yaml`"；CLI 若自行挂一个 mini 组合去写，就是在有 DSH 运行时
当第二个写者（锁与 watch 语义都不受控）。因此登录入口 = **工具 + authorization flow**，
CLI 保持诊断/安装/备份角色。


**已知缺口（P3 需 spike）**：全量 grep 证明 DSH 0.1.7 的**任何客户端都没有调用 `authorization/*`**，
`settings.models.sign-in` 插槽由账号插件占用走 Platform 自己的 remote。因此注册 flow 只是
"可被授权"，**现成 UI 里没有按钮**——入口必须由工具/CLI 提供。

**已知缺口（P2 需 spike）**：原生「设置 → 模型」页对第三方 `settingsNs` 是否给可编辑表单，
还是只给一行（现成编辑器可能只认 deepseek / pi-ai 两个 family）。退路：配置只走 profile patch 层。

### S1 结论（2026-09-26 实测，已答复）

**机制**：`@deepseek-ai/dsh-client-ui-settings-models` 的 provider 行是**按 settings namespace 过滤**的——

```js
const configurable = state.rows.filter((row) => state.namespaces.has(row.entry.settingsNs));   // L2069
const addable = state.rows.flatMap((row) => { const ns = state.namespaces.get(row.entry.settingsNs);
  return ns === undefined || row.configured ? [] : [{ row, namespace: ns }] });                 // L2070
```

`state.namespaces` 来自共享 settings 镜像（`describe()`）。而 0.1.7 的 settings 服务**没有 `register`**，
namespace 只由**条目自己的 Config schema 投影**产生；我们的 `Config` 是手写 Standard Schema，
宿主 Config inspector 直接报 `"status": "unsupported"`，因此**我们的 provider 在原生模型页里根本不存在**：
行不显示，**「添加模型提供商」也不会列出它**。

**实测**：真 0.1.7 实例 + 真浏览器，插件 `state: active` 且已注册进可配置目录，模型页文本只有
`模型 / 填入各提供商的 API 密钥即可使用其模型。/ DeepSeek 编辑 / 添加模型提供商`——没有我们。

**后果**：没有客户端之后，**schemastery Config 是"能被原生 UI 看见"的唯一途径**（这也是所有内置插件的做法）。
否则插件在登录前是**完全不可见**的（`adapter.listModels()` 需要凭据 → 没登录就没模型 → 模型选择器里也没有）。

**P2 决策（已定：C，2026-09-26）**：`Config` 优先用**宿主自带**的 `@deepseek-ai/schemastery`
（不声明为依赖；通过共享锚点解析，含打包 Desktop 的 `resources/app.asar/dsh/node_modules`），
取不到时回退内置 Standard Schema。

**P2 结果（实测）**：
- 光有 schemastery 还不够：DSH 只把**至少有一个 volatile 字段**的 Config 投影成 settings namespace
  （`volatileForm` 无 volatile 就返回 undefined）→ 所以 `provider.defaultModel` / `provider.reasoningEffort`
  标 `.volatile()`，并在 `loader/volatile-update` 里由 `adapter.setDefaults()` 真实采用（loader 是
  **原地改写**插件拿到的那份 config 对象，所以这是唯一的诚实做法）。
- 结果：原生「设置 → 模型」页**出现了我们的行**——`OpenAI (ChatGPT OAuth) / openai-subscription / 编辑`，
  且**未登录时也可见**（这正是 P3 需要的前提）。浏览器实测，无 console 报错。
- 但**表单不可编辑**：编辑器用 `layout = layoutOf(namespace.ns)` 只认 `llm-deepseek` / `llm-pi-ai`
  两个 family，第三方一律 `unknown` → 只显示「其余字段在 cordis.patch.yml 中，请直接编辑对应段。」
  且保存按钮禁用。**这是 DSH 的设计，不是 schema 的问题**。
- 因此 C 的真实收益 = **可发现性**（行出现、可点开、指向配置文件），而不是表单编辑；
  配置仍以 `cordis.patch.yml` 为准（与 A 的结论一致，但不再是"看不见"）。



## 7. 阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 | 冻结基线（tag `v1.5.0-pre-rebuild`）、决策入档 | ✅ |
| P1 | 剥离客户端：删 `client/`、`dsh.client`、`exports`、`files`；删 7 个客户端测试；`doctor` 改为断言"无客户端"；web 门禁反向；新增守卫测试 | ✅ |
| P2 | 原生配置面（含 spike S1） | ✅（行可见；表单只读，配置以 patch 为准） |
| P3 | 登录路径（含 spike S2） | ✅ |
| P4 | 计量与额度的工具化/CLI 化 | ✅（`openai_subscription_quota`、`usage_meter_report`） |
| P5 | 路由收口 | ✅（22 → 1，只读 status） |
| P6 | 门禁重建 | ✅（单测 393、组合 14 项、web/headless PASS） |
| P7 | 发布 2.0.0 | ✅（版本、CHANGELOG、README/docs 重写、重装回 Desktop） |

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

## P8（未决）：打包版 Desktop 里拿不到隔离服务

**现象（实测，非推测）**：同一份 2.0.0 代码在真 `dsh web`（npm 布局）里一切正常——
运行时记录显示 `configSchema: schemastery`、5 个工具全部注册、授权 flow 注册、
`llm/credentials/webServer/authorization/tools/agents/systemPrompt` 全部 present。
但在**打包版 Desktop** 里，同一个探针记录显示：

```json
"configSchema": "standard",
"configSchemaProblem": "... not reachable ... (packaged layouts: Cannot find module '...app.asar.unpacked...')",
"services": { "visible": { "llm": "present", "credentials": "present", "webServer": "present",
                            "authorization": "missing", "tools": "missing",
                            "agents": "missing", "systemPrompt": "missing" } },
"tools": { "registered": [] }
```

**已确认的机制**：cordis 4 的 `ctx.get(name)` 沿 fiber 链上溯，遇到**隔离**该名字的祖先就停下
（`cordis/lib/index.js` 的 `ReflectService.handler.get`：`if (fiber.parent[isolate][prop] !== key) throw error`）。
DSH 把 `tools`/`authorization`/`agents`/`systemPrompt` 隔离在各自的 scope 里，所以根级第三方入口只看得到
`llm`/`credentials`/`webServer`。DSH 自己的工具插件靠**声明 `inject`** 拿到它们
（`dsh-experimental-tool-agent-team`：`inject = ['agents','agentTeams','tools','systemPrompt']`）。

**已做**：`src/index.js` 声明了 `export const inject = ['tools', 'authorization']`；
`config.js` 改为模块级 await + URL 优先导入（`process.resourcesPath` 锚点 + 直接 asar URL）；
新增运行时记录用于从进程外观测。**但 Desktop 里 `inject` 仍未生效**——两种可能：

1. **需要重启**：loader 在安装/首次创建条目时读走了 `inject`，之后改文件只重导入模块、不重建
   entry 的 inject（这条最可能，因为记录显示新代码确实在跑，而服务仍 missing）。
2. `inject` 只对 asar 内的官方插件生效，第三方 link 插件需要另一条路。

**下一步（按顺序）**

1. 重启 DSH Desktop，读 `$DSH_HOME/plugin-state/openai-subscription-runtime.json`：
   若 `services.visible.tools === "present"` 且 `tools.registered` 有 5 个名字 → 问题只是重启；
   若依旧 missing → 走第 2 步。
2. 改走 DSH 自己的模式：像 `dsh-experimental-tool-agent-team` 那样，
   通过 `agents` 服务在**每个 agent scope** 内注册工具（`agent.ctx.tools.register(...)`），
   并在 agent 出现/消失时安装与拆除。注意 `agents` 同样是隔离服务，需先解决可见性，
   或改为在 loader 的 agent 作用域内注入。
3. 备选：向宿主暴露一个 `ctx.get('loader')` 通道来解析宿主包（loader 自己的
   `import(name, baseUrl)` 能读到 asar 内的包），把 schemastery / `defineTool` 走宿主解析而不是自己解析。
