# Spec: 在 DSH 0.1.7 Desktop 上落地并加固 dsh-provider-openai-subscription

Status: ready-for-human
Type: task
Owner: (待认领)
Created: 2026-09-26
Depends on: 无（P0 可立即开始）

## 1. 目标

让本插件在**当前 DSH（0.1.7-rc.2 / Desktop）**上做到四件事，并把过程中的修复固化成可重跑的门禁：

1. **装得上** —— 能在 Desktop 左侧栏「插件」页用本机绝对路径装载。
2. **开得了** —— 改 `state: active` 后重启，Provider 出现在模型列表且能登录。
3. **用得住** —— 流式对话、用量记账、额度指示器、meter 卡片全部正常。
4. **退得掉** —— 卸载或 kill switch 后 profile 照常启动，账本数据不丢。

同时补齐工程化缺口（CI、LICENSE、打包白名单、客户端门禁、文档一致性），使"发布"这件事不再依赖某一次人工验证。

## 2. 事实基线（2026-09-26 实测）

### 2.1 规模与结构

| 维度 | 数值 |
|---|---|
| 文件 / 行数 | 117 个文件，21,536 行（含测试与文档） |
| 生产代码 | `src/` 30 个模块 ≈ 8,900 行；`client/client.js` 2,587 行；`scripts/` 4 个 |
| 测试 | 57 个 `*.test.mjs` + 1 个 `*.e2e.mjs`，426 个断言用例，3.3 s |
| 依赖 | 零运行时依赖（`peerDependencies`/`dependencies` 都为空） |
| 入口 | `src/index.js`（插件）、`client/client.js`（浏览器）、`src/rescue.mjs`（独立 CLI） |
| 组合包声明 | `dsh.bundle.patch` → `cordis.patch.yml`；`dsh.client.platform/inject` |

模块分区：`usage/`（14 模块 / 3,569 行，最大）、`oauth/`（9 / 1,167）、`provider/`（4 / 912）、`rescue.mjs`（676）、`runtime.js`（596）、`web/routes.js`（444）、`credentials/`（3 / 432）、`balance/`（4 / 333）、`models/`（219）、其余（config/state/conflicts/bootstrap/version-range/stream/migration）。

### 2.2 测试覆盖矩阵（src → test）

- **有专属测试**：除下列 4 个外全部覆盖。
- **无直接测试**：`src/index.js`（经 `bootstrap.test.mjs` + 组合 smoke 间接覆盖）、`src/balance/types.js`（纯类型）、`src/usage/reading-slot.js`（经 `usage/service.js` 间接）、`rescue.mjs`（`rescue.test.mjs` 以子进程方式驱动，非 import）。
- **客户端**：6 个 `client-*.test.mjs` 用自己的 `__ModuleLoader__` 假宿主 + 假模块表加载 `client/client.js`；**没有任何针对真实 DSH Web 运行时的客户端门禁**。
- **真实环境门禁**：`test:integration`（真 Cordis 组合）、`test:headless`（真 `dsh --profile headless --json`）、`test:install`（真 `dsh plugin add`）、`test:e2e`（真 DeepSeek 余额，无 Key 跳过）。

### 2.3 发布状态

- 最新已发布：**v1.5.0**（tag `ee9ea45 chore: release 1.5.0`）。
- v1.5.0 之后已有 **5 个已提交**（README 重写、llm 属性读取修复、版本借用门禁、0.1.5 验证记录、文档收尾）。
- **工作树还有一整轮未提交**：新增 `src/usage/model-watch.js`(410) + `test/usage-model-watch.test.mjs`，并改动 `runtime.js`(+96)、`client/client.js`(+36)、`web/routes.js`(+35)、`state.js`(+13)、`usage/config.js`(+7)、两份测试、`README.md`、`HANDOFF.md`、`cordis.patch.yml`（合计 +318 / −29）。`npm run test` 在**这份工作树**上 426/426 通过。
- 无 CI（无 `.github/`）、无 `CHANGELOG.md`、**无 LICENSE 文件**（`package.json` 写了 MIT）、无 `files` 白名单、无锁文件。`npm pack` 目前打 119 个文件 / 358 kB，把 `test/`、`docs/`、预览图、`HANDOFF.md` 全带上。

### 2.4 本机环境事实

- 当前 DSH = **0.1.7-rc.2**（Electron Desktop，运行时在 `resources/app.asar` 内）。
- `DSH_HOME` = `D:\AI\Agents\deepseek-harness`；Desktop profile = `profiles\desktop`，**尚无 `node_modules`，未装任何外部插件**。
- PATH 上的 `dsh`（`D:\AI\Env\bin\dsh.ps1`）指向已不存在的 `apps\cli\lib\bin.js` → **坏的**，所以仓库的 headless/install 门默认只会 SKIP。
- 已就绪的验证环境：`D:\AI\Cache\dsh-0.1.7-verify-npm`（真 npm 安装的 0.1.7-rc.2，518 包）+ `...\home\profiles\node_modules` junction + `...\webhome\profiles\webcheck` 临时 web profile。
- 我在上一轮已实测：组合 smoke 12/12 OK、headless smoke PASS、真实浏览器里插件页面渲染出「(OpenAI 接入 / 插件未激活)」。

### 2.5 已确认的 0.1.7 差距（必须修）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| G1 | `ctx.get('settings').get(ns)` 在 0.1.7 被删 | 0.1.6 的 `settings` 服务有 `get(ns)`（"Read one registered namespace's resolved value"）；0.1.7 的同名服务换成 `SettingsForms`（`super(ctx,"settings")`），只有 `describe/update/replace/mutate/configure`；Cordis 4.0.4 的 `Service` 基类也没有 `get` | `src/runtime.js:369` / `:408` 静默回落，profile 自定义的 `apiKeyEnv` 读不到（本机用的是默认名，暂未暴露） |
| G2 | `integration-smoke` 收尾在 0.1.7 上必然失败 | 3/3 复现 `ENOTEMPTY`，残留 `late-web-server\storages\...\models.json`(422B) 与 `models.json.tmp-*`(0B)；0.1.5 上 exit 0 | `npm run test:integration:strict` 退出 1 → `test:release` 永远红（检查项本身 12/12 全过） |

### 2.6 其它口径问题

- **版本声明**：`engines.dsh = ">=0.1.6-alpha.1"`。插件自带比较器判 `0.1.7-rc.2` 通过（`doctor` 报 `satisfied: true`），但 **node-semver 判 false**（预发布只满足同 `x.y.z` 元组的比较器）。DSH 不读 `engines.dsh`（它只检查 `peerDependencies` 里 `@deepseek-ai/dsh*` 的项，且**没有该字段就放行**），所以目前只是声明口径。
- **README 版本说法**：`README.md:15` 写「0.1.6 及以上」，未记录 0.1.7 实测结论。
- **已知偶发**：`test/oauth-callback-server.test.mjs` 满载时偶发在 `fetch` 处失败（HANDOFF 有记录，未定论）。
- **项目自述的未接线项**：`POST /meter/deepseek/refresh`、`POST /meter/zhipu/refresh` 没有客户端调用者；智谱国际站 `zai` 路由缺凭据条目。

## 3. 必须守住的不变量（改动不得破坏）

1. **零依赖**：`src/` 不 import 任何 npm 包；对 DSH 的引用一律惰性 + `createRequire`。
2. **组合不阻塞启动**：`bootstrap`/`disabled`/kill switch 是正常 no-op；显式 `active` 但不可用时 reject，交给 DSH 的 optional entry 审计。
3. **headless stdout 干净**：`src/`（除 rescue CLI）与 `client/` 不得出现 `console.*` / `process.stdout`。
4. **注册原子**：中途失败逆序回滚，ledger 必然关闭。
5. **fail-closed 栅栏**：有 Connection 服务就永不走 `sameOrigin` 回落；重载空窗期拒绝而不是放宽。
6. **账本只增不改史**：压实前后各时间窗合计逐项相等；绝不编价。
7. **脱敏**：`status`/`doctor`/`meter` 输出与日志不含 token、密码、提示词。

## 4. 规划

### P0 — 冻结工作树（0.5 天，无依赖）

| 任务 | 内容 | 验收 |
|---|---|---|
| P0.1 | 全量复核未提交的一轮：`git diff` + `npm run test`；确认 `modelWatch` 开关在 `cordis.patch.yml`/`README`/`usage/config.js` 三处一致 | 426/426 通过；三处口径一致 |
| P0.2 | 按现有粒度提交（建议拆 2–3 个 commit：feat(model-watch) / feat(client 新模型展示) / docs） | `git status` 干净 |
| P0.3 | 决定版本路径（见 D2） | 决策记录 |

### P1 — DSH 0.1.7 兼容（1–1.5 天）

| 任务 | 涉及 | 验收 |
|---|---|---|
| P1.1 修 G1 | 新增 `readSettingsSection(settings, ns)`：优先 `settings.get?.(ns)`，否则 `settings.describe?.().find(d => d.ns === ns)?.value`；改 `src/runtime.js` 的 DeepSeek / Zhipu 两处解析 | ✅ 已完成。`test/runtime.test.mjs` 新增 3 例：两种服务形状都取到 `apiKeyEnv`、`get` 未命中时回落 `describe()`、无服务时用内置默认名 |
| P1.2 ~~修 G2~~ | ~~`src/web/routes.js` 注册补 `kind: 'exact'`~~ **撤回：误判**。`kind: 'exact'` 自初始提交 `32cbd53` 起就在（`git log -S "kind: 'exact'" -- src/web/routes.js` 只有那一条）。上一版 spec 的这条结论来自一次被过滤掉的 grep——把 `kind:` 行排除在匹配之外。无需改动 | 无 |
| P1.3 修 G2 | `scripts/integration-smoke.mjs`：`late-web-server` 块结束前 dispose `routeCtx`（或 await `modelWatch.settle()`）再 `rm` | 在 0.1.7 上 `test:integration:strict` **exit 0**；0.1.5 仍 0 |
| P1.4 版本口径 | 明确 `engines.dsh` 的处理（见 D6）；`doctor` 输出保持 `null ≠ 通过` | `rescue doctor` 在真 0.1.7 上仍 `ok: true` |
| P1.5 文档 | `README.md:15` 改为「0.1.6 / 0.1.7-rc.2 实测通过」；`HANDOFF.md` 增「DSH 0.1.7 兼容」一节，写清复现命令与 `D:\AI\Cache\dsh-0.1.7-verify-npm` | 文档与实测一致 |

**本阶段的硬门槛**：在真 0.1.7-rc.2 上 `npm run test` + `test:integration:strict` + `test:headless:strict` 全绿。

### P2 — 门禁与打包补强（0.5–1 天）

| 任务 | 内容 | 验收 |
|---|---|---|
| P2.1 | 新增 `scripts/web-smoke.mjs`：临时 home + 临时 profile（`dsh-base` + `dsh-web-app` + 本插件），起 `dsh web --no-open --port <高端口>`，断言首页注入清单含 `dsh-provider-openai-subscription/client.js`，并按 batch URL 抓下 bundle 断言含 `__ModuleLoader__.load` 与关键导出；`--require-dsh` 语义与其它 smoke 一致 | 在 0.1.7 上跑通；缺 dsh 时 SKIP / strict 时 FAIL |
| P2.2（可选） | 把上一轮我用的 Playwright 真浏览器检查固化为 `test:client:browser`，**不进 release 门**（依赖浏览器，环境重） | 能复现「设置页出现 OpenAI 接入」 |
| P2.3 | 补 `LICENSE`（MIT 全文）；`package.json` 加 `files` 白名单（`src`/`client`/`cordis.patch.yml`/`README.md`/`LICENSE`）、`repository`/`bugs`/`homepage` | `npm pack --dry-run` 不再包含 `test/`、`docs/images`、`HANDOFF.md`；包体明显变小 |
| P2.4 | 决定 CI（见 D3）：至少 `check` + `test`；可选在 CI 里 `npm i @deepseek-ai/dsh@<pin>` 后跑两个 strict 门 | 决策记录 + （若做）首次流水线绿 |

### P3 — Desktop 接入（0.5 天）

| 任务 | 内容 | 验收 |
|---|---|---|
| P3.1 | 定安装形态（见 D1） | 决策记录 |
| P3.2 | 左侧栏「插件」→ 粘贴绝对路径安装；核对 `profiles\desktop\package.json` 的 `dependencies` + `dsh.profile.bundles`，以及 `node_modules` 出现 | 插件页出现组合包 + `llm-openai-subscription` 行 |
| P3.3 | 追加激活层到 `profiles\desktop\cordis.patch.yml`（该文件已是 YAML 序列，**追加**即可，不是替换 `[]`）：`- id: llm-openai-subscription` + `config.state: active` + `config.oauth.clientId` | 重启后 `dsh --profile desktop --dump-config` 能看到 active 行 |
| P3.4 | 端到端验收（见 §5） | §5 全过 |
| P3.5 | 回滚演练：插件页卸载 → 重启 → profile 正常；再确认 `storages/openai-subscription-meter/usage.json` 与 `plugin-state/openai-subscription-meter.json` 保留 | profile 能启动；账本在两处仍在 |

**注意**：Desktop 的包管理操作由 Desktop shell 负责（shell 把 `resources/runtime/pnpm/bin/pnpm.mjs` 传给运行时子进程）；若页面按钮行为与预期不符，兜底方案是手工改 `profiles\desktop\package.json`（deps + bundles）后重启，效果等价。

### P4 — 发布（0.5 天）

| 任务 | 内容 |
|---|---|
| P4.1 | 按 D2 的结论定版本号；README/CHANGELOG 摘要 |
| P4.2 | `chore: release <ver>` 提交 + 附注 tag + GitHub Release（沿用 1.4.0/1.5.0 习惯） |
| P4.3（可选） | `npm publish`（前提：P2.3 的 `files`/LICENSE 已完成；这会打开"插件页按包名安装"这条路，见 D5） |

### P5 — 文档与交接（0.5 天）

- P5.1 `HANDOFF.md`：增「DSH 0.1.7 兼容」「Desktop 插件页接入」「真实 web/client 门禁」三节，含复现命令与踩坑（含 `settings.get` 被删、semver 预发布规则、smoke teardown 竞态）。
- P5.2 `docs/usage-meter.md`：模块目录里补 `model-watch.js` 一节（设计文档现在缺它）。
- P5.3 `README.md` 安装章节同时给两条路径：Desktop 插件页（绝对路径）与 `dsh plugin add` CLI。

### P6 —  backlog（非本轮，按价值排序）

1. 智谱国际站 `zai` 路由的凭据条目 + 账号读数（现在只有中国站有客户端入口）。
2. `POST /meter/{deepseek,zhipu}/refresh` 接上客户端调用者（现在靠轮询 + TTL 自刷新）。
3. `test/oauth-callback-server.test.mjs` 偶发失败定论（先抓 undici 的 `code`，再决定给临时端口路径加重试还是让测试对连接类错误重试）。
4. 价格表跨档按"开始时刻"取档，可考虑显示区间估算（当前是单档取值）。
5. `usage/reading-slot.js` 补直接单测（目前只有间接覆盖）。

## 5. 端到端验收清单（用户视角）

1. 插件页出现该组合包，行列表出现 `llm-openai-subscription`。
2. 重启 Desktop 后，模型选择器里出现 `openai-subscription` 及其模型。
3. 「设置 → OpenAI 接入」能用三种方式之一完成登录（浏览器授权 / 手动粘贴回调 / 设备码）。
4. 发一条对话：流式输出正常，消息下方出现用量数字。
5. 侧边栏底部指示器显示 OpenAI 额度窗口（`OpenAI 5小时 xx% · 每周 xx%`）。
6. 点开卡片：本会话/今日/本月 token、按模型拆分、`新模型:` 行（若有）正常。
7. `dsh-openai-subscription-rescue doctor --profile <desktop package.json>` 返回 `ok: true`，且 `compatibility.satisfied` 为 true。
8. 回滚：卸载 + 重启后 profile 正常启动，账本与设置文件仍在。

## 6. 决策点（需人工拍板）

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| D1 | 安装形态 | ①绝对路径 `link:` ②`npm pack` 出 tgz ③发 npm 用包名 | 开发期 ①，分发用 ③；②适合"不发布但想固定"的场合。①与 git 操作耦合，注意 |
| D2 | 版本路径 | ①先 1.5.1（model-watch）再 1.6.0（0.1.7 兼容）②合并成 1.6.0 | ②。model-watch 尚未发布过，分开只是多一次发布动作 |
| D3 | CI | ①不做 ②只在 push/PR 跑 `check`+`test` ③再加两个 strict 门（需在 CI 装 DSH） | ②先做；③等 P1 的 0.1.7 门禁稳定后再上 |
| D4 | 浏览器门禁入库 | ①只做 HTTP 层 web-smoke（P2.1）②额外入库 Playwright 检查 | ①必需；②可选，价值在 UI 回归 |
| D5 | 是否发布 npm | ①不发（保持 link/tgz）②发 | 若要"像其它插件一样用包名安装"就必须发；不发也能用绝对路径装 |
| D6 | 是否给 `@deepseek-ai/dsh*` 加 `peerDependencies` | ①不加 ②加 | **不加**。加了会激活 DSH 的兼容门（`evaluatePluginCompatibility`），把"未知"变成"可拒绝"，收益为零；`engines.dsh` 保持现状 + 文档说明即可 |
| D7 | 激活层的 `oauth.clientId` 来源 | ①写死在 patch ②从环境/设置读 | 沿用现有 `config.oauth.clientId`（项目既有设计）；client id 属公开常量，不是密钥 |

## 7. 风险登记

| # | 风险 | 概率/影响 | 缓解 |
|---|---|---|---|
| R1 | Codex 非公开接口漂移（字段/协议变更） | 中 / 高 | 已有错误分类与「需要重新登录」提示；建议在 rescue 里加一次性诊断输出（不含敏感值） |
| R2 | 0.1.7 正式版相对 rc.2 再漂移 | 中 / 中 | 把 0.1.7 验证做成可重跑脚本；每次 DSH 升级后跑一遍 P1 门槛 |
| R3 | `link:` 安装与工作区 git 操作耦合（checkout/stash 直接换掉运行中的代码） | 高 / 中 | 分发用 tgz 或固定 tag；开发期明确"改完重启 profile" |
| R4 | Desktop 包操作由 shell 负责，页面行为与 CLI 不完全一致 | 中 / 低 | 兜底手工改 `package.json` + 重启 |
| R5 | 全量测试偶发（oauth-callback-server） | 低 / 中 | 先抓 `code` 定位，再决定重试或修 `port: 0` 两步绑定 |
| R6 | 无 CI，回归只能靠本地 | 高 / 中 | P2.4 |
| R7 | 账本 20k 上限 + rollup：会话级明细回溯受 `retentionDays` 限制 | 已发生 / 低 | 文档已写明；需要更长回溯就把 `retentionDays` 调大或设 0 |
| R8 | 本机 PATH 上 `dsh` 损坏，容易把「跳过」误读成「通过」 | 高 / 低 | 统一用 `D:\AI\Cache\dsh-0.1.7-verify-npm`；修 `D:\AI\Env\bin\dsh.ps1` |

## 8. 复现环境（本机已就绪）

```powershell
# 真实的 DSH 0.1.7-rc.2（npm 安装，518 包）
$root = 'D:\AI\Cache\dsh-0.1.7-verify-npm'

# 组合 smoke（12 项检查）
$env:DSH_NODE_MODULES = "$root\node_modules"; $env:DSH_HOME = "$root\home"
node scripts/integration-smoke.mjs --require-dsh

# headless 门（真 CLI + NDJSON 契约）
$env:PATH = "$root\node_modules\.bin;$env:PATH"; $env:DSH_HOME = "$root\home"
node scripts/headless-smoke.mjs --require-dsh

# 真实 web 运行时（临时 profile，验证客户端 bundle 注入）
# 见 D:\AI\Cache\dsh-0.1.7-verify-npm\webhome\profiles\webcheck
& "$root\node_modules\.bin\dsh.cmd" --profile webcheck --no-open --port 39117
```

## 9. 估算

| 阶段 | 人日 |
|---|---|
| P0 冻结 | 0.5 |
| P1 兼容修复 | 1.0–1.5 |
| P2 门禁与打包 | 0.5–1.0 |
| P3 Desktop 接入 | 0.5 |
| P4 发布 | 0.5 |
| P5 文档交接 | 0.5 |
| **合计** | **3.5–4.5** |

## Comments

- 2026-09-26 初版。基于对全仓 117 个文件/21,536 行的通读、真实 0.1.7-rc.2 的组合与 headless 门禁、以及一次真实浏览器内的客户端渲染验证。
- 2026-09-26 **更正**：初版 §2.5 的 G2「Web 路由未传 `kind`」是误判。`kind: 'exact'` 自初始提交 `32cbd53` 起就在 `src/web/routes.js`；那条结论产生于一次把 `kind:` 行排除在外的 grep（模式为 `register|path:|methods|handler`）。已从问题清单与 P1 计划中撤回，G3 顺次改为 G2。教训：**结论性的 API 审查要用整段读取或多模式 grep 复核，不要用窄模式的一次匹配下断言**。
- 2026-09-26 P0 完成：工作树里的两轮未提交工作拆成 3 个提交（`36ecc55` 连接栅栏 / `7db5994` model-watch 后端 / `85d59d3` 客户端展示），各自可验证；`36ecc55` 单独 stash 出其余改动后跑测 418/418 通过。
- 2026-09-26 P1.1 完成：`readSettingsSection()` 兜底两种服务形状，补上此前**完全没有测试**的 `resolveDeepSeekCredential` / `resolveZhipuCredential` 路径。

