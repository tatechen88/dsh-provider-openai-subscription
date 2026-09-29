# dsh-provider-openai-subscription

用你的 **ChatGPT / Codex 订阅**账号，在 DeepSeek Harness 里直接使用 OpenAI 模型。

这是一个**纯宿主插件**：它给 DSH 加一条 Provider 路由、一个 DSH 原生的授权流程，以及几个 agent 工具。
它**不带任何浏览器界面**——没有侧边栏指示器，没有自带设置页。

> 为什么这样设计：DSH 0.1.7 里，一个导入失败的客户端 entry 是**致命的 web 启动错误**
> （`web boot: 1 entry did not activate`），Desktop 外壳会因此崩溃重启。曾经因为运行中改一次客户端文件
> 就实测触发过。结论不是"小心地改客户端"，而是**不存在客户端**：这个插件现在只由宿主侧代码组成。
> 登录、额度、用量都改用 DSH 原生面 + agent 工具承载。

> ⚠️ 它连的是 ChatGPT 订阅在用的**非公开接口**，不是 OpenAI 的 Platform API。用之前请自行确认账号、OAuth Client ID 和这个接口的使用风险。

## 准备工作

| | |
|---|---|
| DSH | **0.1.6 及以上**。0.1.6-alpha.1 与 **0.1.7-rc.2** 均实测通过（组合、headless、真实 `dsh web` 三条门禁）；0.1.5 实测能用，但不在支持范围内 |
| Node.js | 22.19+ 或 24+ |
| 账号 | 一个 ChatGPT 订阅账号（Plus / Pro / Team 等） |

## 安装

```sh
dsh plugin --profile <你的-profile> add /path/to/dsh-provider-openai-subscription
```

装完之后插件默认是**关着的**，不会影响 DSH 启动。想开启就编辑 profile 的 patch 层：

```
$DSH_HOME/profiles/<你的-profile>/cordis.patch.yml
```

在里面加一段（**替换整个文件内容只在文件出厂时是 `[]` 的情况下适用**）：

```yaml
- id: llm-openai-subscription
  name: dsh-provider-openai-subscription
  config:
    state: active
    oauth:
      clientId: "<你的-client-id>"
```

> **注意 YAML 合法性。** 如果这个文件本来只有一个 `[]`，要把内容写在它**里面或替换它**，
> 直接在 `[]` 后面追加不是合法 YAML，DSH 会报 `failed to parse overlay`，表现是**整个 profile 起不来**。
> 真写成那样了也不慌：`dsh-openai-subscription-rescue doctor` 会认出来并告诉你怎么改。

保存，然后**重启这个 profile**（运行时是 profile 加载的，刷新页面没用）。

### 装完怎么登录

打开一个新会话，让 agent 调用登录工具即可（对话里说"帮我登录 ChatGPT 订阅"就行）：

| 工具 | 作用 |
|---|---|
| `openai_subscription_login` | 开始登录。默认给一条链接，在你的浏览器里打开；`method: "device"` 则给一个设备码 |
| `openai_subscription_status` | 看是否已登录、账号、到期时间、是否有登录正等着你完成 |
| `openai_subscription_logout` | 忘掉本机保存的凭据（不动订阅本身） |
| `openai_subscription_quota` | 订阅额度还剩多少（各限流窗口） |
| `usage_meter_report` | 今日 / 本月 / 本会话的 token 与估算费用 |

登录调用会**等一小会儿**（默认 60 秒）。你没等它完成也不要紧：**尝试不会被取消**——链接依然有效，
你打开并登录成功后，再跑一次 `openai_subscription_status` 就能看到已登录。想主动放弃才需要 `_logout`。

登录凭据随时可以重来，`_logout` 只是删掉本机记录，不会通知签发方。

<details>
<summary>想确认自己装对了（点开）</summary>

```sh
# 组合树里应该能看到这一行
dsh --profile <你的-profile> --dump-config | grep -A2 llm-openai-subscription

# 依赖、bundle、激活层是否一致（离线检查，不会启动 DSH）
dsh-openai-subscription-rescue doctor --profile "$DSH_HOME/profiles/<你的-profile>/package.json"
```

`doctor` 还会报告 `clientFree: true`——插件**声明了没有浏览器半边**，磁盘上也没有 `client/` 目录。
这不是凑数的字段：它是"不会因为客户端 entry 导入失败而炸掉 DSH"这条保证的检查点。

</details>

## 它能做什么

- **三种登录方式**：浏览器授权码（回环回调）、手动粘贴回调地址、设备码。工具与 DSH 的授权 seam 都能发起。
- **正常的流式输出**，token 用量如实上报——包括缓存命中和思考 token。DSH 每条消息下面的用量数字就是它报上去的。
- **出现在 DSH 原生「设置 → 模型」页**：能看见 `OpenAI (ChatGPT OAuth)` 这一行、点开它、并从那里发起"获取可用模型"。
  该页对第三方 Provider 是**只读**的（这是 DSH 的设计——它只为内置的 DeepSeek / pi-ai 两族生成编辑表单），
  点开会告诉你配置在 `cordis.patch.yml` 的哪一段。
- **模型目录是个活的**：每 10 分钟自动重新拉一次；原生模型页的「获取可用模型」会真的清缓存重拉。OpenAI 上了新模型不用等插件发版。
- **额度与用量随时可问**：`openai_subscription_quota` 读订阅自己的限流窗口，`usage_meter_report` 读本机账本。
- **新模型有人盯**：每 30 分钟扫一次 DeepSeek、智谱和 OpenAI 订阅三家的模型目录，出现本机没见过的模型就在用量报告里点名——不用等插件发版。首次扫描只建立基线。
- **不和别人抢**：用独立的 Provider ID、设置命名空间和凭据键，不会覆盖旧的 `openai-codex` 插件，两个可以同时装着、按会话切换。
- **它挂了也不会拖住 DSH**：配置或加载出错时，DSH 只记一条启动警告、照常启动，其它插件不受影响。

## 用量与费用

插件自带统计，**不需要另外装 `dsh-cost-meter`**。它记住每一次模型调用的 token，再按价格表估算费用，
由 `usage_meter_report` 按需报告（默认今日；也可以要本月、本会话或全部）。

关于钱，有三件事值得先说清楚：

- **OpenAI 订阅不显示金额。** 订阅是按月付的，不是按 token 结算的；它的"还剩多少"由 `openai_subscription_quota` 回答。
- **GLM 只数 token，不算钱。** 智谱的 Coding Plan 同样是订阅制，没有可引用的按 token 费率。
- **DeepSeek 显示的是本地估算。** 官方公开接口只给余额，没有账单历史，所以费用是插件自己按 token × 价格表算的，报告里一律标着「估算」。

**任何 DSH 里注册过的 Provider 都会被统计**，不需要改代码或等新版本——你换到一个别的插件刚注册的模型，它的 token 立刻开始记账。没有账号读数就不显示余额，没有价格表就不显示金额，**不会拿别家厂商的数字顶替**。

遇到内置价格表里没有的新模型，报告会把它**点名**列在 `unpricedModels` 里（而不是瞎猜一个价）。如果你愿意，可以打开 `meter.refreshPublicPrices`，让插件读一次 [DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 把表补齐——这是插件唯一一个与账号无关的外发请求，所以默认是**关**的。

<details>
<summary>账本、历史和隐私（点开）</summary>

- 账本在 `$DSH_HOME/storages/openai-subscription-meter/usage.json`，**只记调用事实和当时的报价**，不存提示词、不存回复内容、不存密钥。模型检测的基线在同目录 `models.json`，只记「见过哪些模型名」，删掉也没事，下次扫描重建。
- 计量设置可以在 `$DSH_HOME/plugin-state/openai-subscription-meter.json` 里覆盖（带版本号；这个文件是"用户层"，优先级高于 profile 的 `meter:` 默认值）。没有界面写它——它由人手改或由程序写。
- 超过 `meter.retentionDays`（默认 90 天）的原始记录会在启动时折叠成「每天 × 每路由 × 每模型」的汇总，**所有时间窗的合计一分不差**，只是会话级明细最多回溯这么久。设成 0 就永不折叠。
- 余额查询每次重新读一遍密钥，只发给 `api.deepseek.com` 的 HTTPS，禁止跳转；失败就保留上一次成功的读数。
- 价格页请求不带任何凭据（那是公开文档页），同样禁止跳转。

</details>

<details>
<summary>从 dsh-cost-meter 换过来（点开）</summary>

两个插件会统计同一批调用，别长期同时开着：

1. 在 profile 的 `package.json` 里，从 `dependencies` 和 `dsh.profile.bundles` 两处删掉 `dsh-cost-meter`；
2. 如果 `pnpm-workspace.yaml` 里有指向它的 `patchedDependencies`，一并删掉——否则下次 `pnpm install` 会因为找不到补丁目标而失败；
3. 重启 profile。残留的 `node_modules/dsh-cost-meter` 不影响启动；
4. 旧账本 `$DSH_HOME/storages/cost-meter/ledger.json` 不会被读、改、删，想归档自己挪；
5. 想回滚就重新装回 `dsh-cost-meter`，本插件的账本原封不动。

</details>

## 配置

profile 里那段 YAML 的 `config` 支持这些字段：

| 字段 | 说明 |
|---|---|
| `state` | `bootstrap`（默认，不加载）、`disabled`、或 `active`（真正启用） |
| `oauth.clientId` | OAuth Client ID。留空就不会加载 |
| `oauth.callbackPort` | 回环回调端口，默认 `1455`，取值 1–65535 的整数。**Windows 上常常必须改**：Hyper-V/WSL/Docker 会动态预留一段端口，落在段里的端口**任何进程都绑不上**（`bind` 报 `EACCES`，而 `netstat` 里看不到占用者）。查保留段用 `netsh int ipv4 show excludedportrange protocol=tcp`，挑一个段外端口填这里。**不接受 `0`**：redirect_uri 必须在打开浏览器之前就已知，系统随机端口等于没人能回调。不可绑时插件会**明确报错并点名端口**，不会偷偷换一个 |
| `provider.defaultModel` | 默认模型，可以留空。**标为 volatile**：改动会被运行中的插件直接采用，不用重启 |
| `provider.reasoningEffort` | 默认思考力度，可以留空。同样 volatile |
| `provider.streamTimeoutMs` | 一次模型调用的**整体超时**（响应头 + 整个 SSE 流），默认 `300000`（5 分钟），范围 1000–600000。同样 volatile。来源：旧版硬编码 120 秒，上游拥堵期响应一旦超过它，正在生成的流会被直接掐断（表现为整轮 "This operation was aborted"） |
| `meter.*` | 用量模块的默认值，字段说明见插件自带的 `cordis.patch.yml`（含 `modelWatch` 新模型检测开关，默认开） |

字段类型写错（比如 `state: 5`）会在插件加载前就被拒绝，并在 DSH 启动输出里点名是哪个字段，而不是悄悄当成默认值——省得你对着「插件怎么不加载」发呆。

`provider.defaultModel` / `provider.reasoningEffort` / `provider.streamTimeoutMs` 是插件里**仅有的三个**标了 volatile 的字段：只有它们能在运行中被真正采用
（adapter 会立刻改用新值），所以只有它们会出现在设置表单的投影里。其余字段只在激活时生效，标成 volatile 就等于给你一个"改了要等重启"的假开关。

## 语言：跟随当前语言（中文 / English）

插件对**人说的话**——工具描述、错误文案、登录提示、路由错误——会跟随当前语言：

1. 优先读 DSH 自己的语言偏好（**设置 → 通用 → Language** 写的那个值）；
2. 读不到时退回**进程 / 系统语言**（中文系统 → 中文）；
3. 都没有 → 英文。

机器读的值（JSON 字段名、状态码、错误 `code`、模型 id）保持英文，因为它们是给程序匹配的。

**插件页那张卡片**的文案走 DSH 自己的约定：`locale/en.json` 与 `locale/zh.json` 里的
`meta.title` / `meta.description`（内置 bundle 也是这么做的）。两个坑：

- 这两个文件必须写进 `package.json` 的 `exports`（`"./locale/*.json"`）。没有它，Node 会以
  `ERR_PACKAGE_PATH_NOT_EXPORTED` 拒绝解析，DSH 读成"没有元数据"，卡片回落到清单里的英文。
- 在 0.1.7 的 Desktop 组合里，插件页目前**没有**投影这份 `meta`——DSH 自带的本地化 bundle
  （voice-input 带 `locale/{en,zh}.json`）同样如此，所以卡片可能仍是英文，直到宿主侧接通。

**生效时机**：工具描述在激活时注册、不能原地改词，所以**改语言后要等下一次激活**（重启一次，或在插件页停用再启用）。
当前生效的语言记录在运行时记录的 `language` 字段里。

## 出问题时

### 模型列表报 `Model catalog request failed: fetch failed`

这是 Node.js 没能完成网络请求，**不是**登录失效。按顺序排查：

1. 在 **设置 → 模型** 里点一次「获取可用模型」重试；
2. 确认跑 DSH 的那个 Node 进程能访问 `chatgpt.com`；
3. 检查代理规则放不放行 `chatgpt.com` 和 `auth.openai.com`；
4. 浏览器能上但 DSH 不能？看启动 DSH 的终端里 `HTTP_PROXY` / `HTTPS_PROXY` / TUN 路由配对了没；
5. 网络恢复后重启 profile，把残留的旧错误清掉。

真是凭据失效的话，插件会直接说「需要重新登录」；上游返回异常时会带上 HTTP 状态码。看到那两种提示才需要去查登录状态。

### 登录点了链接，但 status 还是没登录

1. `openai_subscription_status` 看 `login.attempt` 里的 URL——若还在 `waiting`，说明浏览器那一步没走完；
2. 回环回调需要一个本机端口（默认 `127.0.0.1:1455`）：被占用或被杀软拦截时，链接会打开但回调进不来；
   - 报错是 **`oauth callback port 1455 is unavailable on IPv4`** 时，先别去找占用进程：Windows 会把整段端口动态预留（**`EACCES` 而不是 `EADDRINUSE`**，`netstat` 里是空的）。跑 `netsh int ipv4 show excludedportrange protocol=tcp` 看 `1455` 是否落在某个保留段里，是的话把 `oauth.callbackPort` 改到段外（本机实测 `1437-1536` 被占，`1537` 可用）。**该段重启后会漂移**，换过环境要重查；
3. 换成 `method: "device"`，用设备码在别的设备上完成；
4. 想重来：`openai_subscription_logout` 会取消挂起的尝试并清掉旧记录。

### 改完代码，刷新浏览器没反应

插件**没有浏览器半边**，所以不存在"网页热更新"这回事：运行时由 profile 加载，改完 **重启 profile**。

### 想临时关掉它

```sh
dsh-openai-subscription-rescue disable   # 关
dsh-openai-subscription-rescue enable    # 开
```

这个命令不依赖插件本身，所以插件把 DSH 搞得起不来的时候它照样能用。

### Rescue CLI 的其它命令

```sh
dsh-openai-subscription-rescue status    # 看一眼当前状态（脱敏）
dsh-openai-subscription-rescue meter     # 账本和设置文件的落盘状态
dsh-openai-subscription-rescue doctor --profile path/to/package.json
dsh-openai-subscription-rescue snapshot  --profile .../package.json --patch .../cordis.patch.yml
dsh-openai-subscription-rescue rollback  --path .../openai-subscription-snapshots --target .../package.json
```

`status` 之类的输出都会脱敏，OAuth token 不会出现在里面。`doctor` 会顺带告诉你装的是哪个 DSH 版本、以及它满不满足插件声明的 `>=0.1.6-alpha.1`；读不到就写 `null`（**「不知道」不等于「通过」**），插件文件缺失时以非零码退出，可以直接当脚本门禁用。

**CLI 不做登录**：凭据只能经 DSH 的凭据 seam 写入，而这个插件承诺绝不绕过 DSH 直接改 `.credentials.yaml`。
CLI 若自己挂一套组合去写，就是在 DSH 运行时当第二个写者。登录请用工具。

## 和旧的 openai-codex 共存

插件发现旧的 `openai-codex` 之后**只报告状态**（`openai_subscription_status` 的 `legacy` 字段），不会搬凭据、也不会删它。
两者凭据键和设置命名空间都不同，可以同时存在、按会话切换。当前会话用的是旧 Provider 时，本插件不会去查它的额度。

想迁移就直接用新 Provider 登录一次；旧记录原地不动，随时可以回头。

## 已知限制

- **没有任何自带界面**：没有侧边栏指示器、没有用量卡片、没有自带设置页。额度与用量通过工具按需查询。
- **登录必须由工具或 DSH 的授权面发起**：DSH 0.1.7 现成 UI 里没有任何按钮会调用第三方插件的授权 flow（实测），所以没有"点一下就登录"的图形入口。
- 原生「设置 → 模型」页对第三方 Provider 只读：DSH 只为内置的两族 Provider 生成编辑表单，配置以 `cordis.patch.yml` 为准。
- ChatGPT / Codex 的非公开接口可能随时改协议或字段。
- 缓存命中率依赖上游上报 `cached_tokens`；不上报就没有这个数字（也不会假装是 0）。
- DeepSeek 费用是本地估算，价格是 2026-09-15 的公开价快照；跨价格档的请求按**开始时刻**取档。
- 自动纳入计量的 Provider **只记 token**。「还剩多少额度」和「多少钱」需要在 `src/usage/vendors.js` 里显式登记。
- 账号类型靠你声明，插件不检测也不展示官方账单、发票或信用额度。
- 只统计本机这个 DSH 进程里的调用，同账号在别处的消耗不会进本地账本。

## 开发

```sh
npm test                  # 单元测试
npm run check             # 语法检查 + 全部单元测试
npm run test:e2e          # 真实 DeepSeek 余额查询；没有 Key 时会跳过
npm run test:integration  # 真实 DSH 组合 smoke（缺 DSH 依赖时跳过）
npm run test:web          # 真实 dsh web：页面里不含本插件、宿主侧路由确实挂载（缺 DSH 时跳过）
npm run test:headless     # 真实 dsh --profile headless --json 跑一遍（缺 dsh 时跳过）
npm run test:release      # 发布前跑：单元测试 + 三个 strict 门禁
```

`test:integration` 会把插件装进真实的 Cordis 上下文跑一次 `llm/stream`，验证它变成一条已计价记录，并且把结果送进 DSH 自己的流式校验器；同一个门禁还会拿**真实的授权服务**驱动我们的登录 flow，以及让**真实的 `defineTool`** 接受并执行全部工具定义。`test:web` 会用临时 profile 真的起一次 `dsh web`，断言**首页里没有本插件的任何痕迹**（没有 `dsh.client`、没有预加载、没有 bundle 行），同时从服务端确认宿主半边确实挂载了（自己的路由 401、无人认领的路径 404）——不需要浏览器，也不需要登录。`test:headless` 会真的启动一次 `dsh --profile headless --json`（在临时 DSH home 里，用一个 mock 模型路由，不联网），检查输出流是干净的 JSON、账本按会话记账。

这三条都需要本机装了 DSH，否则会跳过；加 `:strict` 或直接跑 `test:release` 就会把「跳过」当成失败——免得出现「因为没装 DSH 所以绿灯」的假通过。

<details>
<summary>代码大致在哪（点开）</summary>

```text
src/
  index.js / bootstrap.js   插件入口与安全引导
  runtime.js                装配：凭据、OAuth、adapter、工具、授权 flow、唯一那条路由
  config.js                 配置校验，以及"用哪套 schema"的选择（见下）
  dsh-modules.js            解析宿主自带包（schemastery / dsh-tools）的统一锚点
  operations.js             工具、授权 flow 共用的唯一实现（status/login/logout/quota/usage）
  tools.js                  agent 工具定义（交给宿主的 defineTool 塑形）
  oauth/                    登录流程（PKCE、设备码、回调）与授权 seam 的 flow
  balance/  models/         额度查询、模型目录
  usage/                    用量账本、价格表、计量服务
  provider/                 把 DSH 的请求翻译成 Codex Responses，再翻译回来
  web/routes.js             唯一一条只读 status 路由（带部署栅栏）
cordis.patch.yml            插件自带的默认配置层
```

**为什么用宿主自带的 schemastery**：DSH 只为"Config schema 带 `toJSON` 且至少有一个 volatile 字段"的条目生成
settings namespace，而原生模型页只列出有 namespace 的 Provider。没有它，插件在 UI 里完全不可见。
所以 `config.js` 优先用宿主提供的 `@deepseek-ai/schemastery`（`dsh-modules.js` 解析，含打包版 `app.asar` 锚点），
**取不到就回退内置的 Standard Schema**——schemastery 不是这个包的依赖，`package.json` 的依赖表依然是空的。

浏览器半边已删除：`dsh.client` 声明、`exports["./client"]`、`client/` 目录都不再存在，
`test/no-client.test.mjs` 会阻止它们回来。

</details>

## 许可证

MIT
