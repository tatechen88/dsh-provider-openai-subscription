# dsh-provider-openai-subscription

用你的 **ChatGPT / Codex 订阅**账号，在 DeepSeek Harness 里直接使用 OpenAI 模型。

装好之后，DSH 的模型列表里会多出一个 `openai-subscription`，选它就能像平时一样对话、调用工具；侧边栏底部会多一个小指示器，告诉你订阅额度还剩多少、这次会话用了多少。

> ⚠️ 它连的是 ChatGPT 订阅在用的**非公开接口**，不是 OpenAI 的 Platform API。用之前请自行确认账号、OAuth Client ID 和这个接口的使用风险。

![效果预览](docs/images/openai-subscription-preview.png)

## 准备工作

| | |
|---|---|
| DSH | **0.1.6 及以上**。本版本针对 0.1.6 的接口调整过，更早的版本没有验证过 |
| Node.js | 22.19+ 或 24+ |
| 账号 | 一个 ChatGPT 订阅账号（Plus / Pro / Team 等） |

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-provider-openai-subscription
```

装完之后插件默认是**关着的**，不会影响 DSH 启动。想开启就编辑这个文件：

```
$DSH_HOME/profiles/web/cordis.patch.yml
```

**把整个文件的内容替换成下面这几行**，填上你的 Client ID：

```yaml
- id: llm-openai-subscription
  name: dsh-provider-openai-subscription
  config:
    state: active
    oauth:
      clientId: "<你的-client-id>"
```

> **一定要「替换」，不要在 `[]` 后面追加。**
> 这个文件出厂时里面只有一个 `[]`。把内容写在它后面不是合法的 YAML，DSH 会报
> `failed to parse overlay`，表现是**整个 profile 起不来**。
> 真写成那样了也不慌：`dsh-openai-subscription-rescue doctor` 会认出来并告诉你怎么改。

保存，然后**重启这个 profile**（刷新浏览器不够用），再到 **设置 → 模型** 里点连接、用 ChatGPT 账号登录。

就这样。模型列表里会出现 `openai-subscription`，和别的 Provider 一样选。

<details>
<summary>想确认自己装对了（点开）</summary>

```sh
# 组合树里应该能看到这一行
dsh --profile web --dump-config | grep -A2 llm-openai-subscription

# 依赖、bundle、激活层是否一致（离线检查，不会启动 DSH）
dsh-openai-subscription-rescue doctor --profile "$DSH_HOME/profiles/web/package.json"
```

</details>

## 它能做什么

- **三种登录方式**：浏览器授权码、手动粘贴回调地址、设备码。哪个顺手用哪个。
- **正常的流式输出**，token 用量如实上报——包括缓存命中和思考 token。DSH 每条消息下面的用量数字就是它报上去的。
- **模型目录是个活的**：每 10 分钟自动重新拉一次，设置页的「刷新」也会真的清缓存重拉。OpenAI 上了新模型不用等插件发版，也不用重启。
- **额度一目了然**：侧边栏底部的指示器跟着当前模型走，OpenAI 订阅、DeepSeek、智谱 GLM 的额度都显示在同一个地方。
- **不和别人抢**：用独立的 Provider ID、设置命名空间和凭据键，不会覆盖旧的 `openai-codex` 插件，两个可以同时装着、按会话切换。
- **它挂了也不会拖住 DSH**：配置或加载出错时，DSH 只记一条启动警告、照常启动，其它插件不受影响。

## 侧边栏底部那个指示器

宽屏时它直接显示文字，不用点：

| 你在用 | 它显示 |
|---|---|
| OpenAI 订阅 | `OpenAI 5小时 82% · 每周 64%` |
| DeepSeek | `DeepSeek ¥86.20 · 今日 ¥0.42` |
| 智谱 GLM | `GLM 余 14M · 今日 1.2M` |
| 其它已注册的 Provider | `<名字> 今日 3.4M` |

点一下会展开一张卡片，里面有更细的内容：各个额度窗口、本会话 / 今日 / 本月的 token、会话里最重的几个模型，等等。

手机上（或者从别的设备接过来用）它会自动收成一个柱状图小图标，点开才展开——不会挤占屏幕。**图标可以拖到任何位置**，它会记住，双击复位。卡片没人管 12 秒后自己收回，点别处、再点一次图标、按 Esc 也都能收起。

指示器浮在页面之上，不会被侧边栏裁掉。

## 用量与费用

插件自带统计，**不需要另外装 `dsh-cost-meter`**。它记住每一次模型调用的 token，再按价格表估算费用。

关于钱，有三件事值得先说清楚：

- **OpenAI 订阅不显示金额。** 订阅是按月付的，不是按 token 结算的，硬把 API 目录价套上去只会误导你。
- **GLM 只数 token，不算钱。** 智谱的 Coding Plan 同样是订阅制，没有可引用的按 token 费率。
- **DeepSeek 显示的是本地估算。** 官方公开接口只给余额，没有账单历史，所以费用是插件自己按 token × 价格表算的，界面上一律标着「估算」。

**任何 DSH 里注册过的 Provider 都会被统计**，不需要改代码或等新版本——你换到一个别的插件刚注册的模型，它的 token 立刻开始记账。没有账号读数就不显示余额，没有价格表就不显示金额，**不会拿别家厂商的数字顶替**。

遇到内置价格表里没有的新模型，卡片会把它**点名**列出来（`未配置价格: deepseek-v5 ×3`），而不是瞎猜一个价。如果你愿意，可以打开 `meter.refreshPublicPrices`，让插件读一次 [DeepSeek 官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 把表补齐——这是插件唯一一个与账号无关的外发请求，所以默认是**关**的。

<details>
<summary>账本、历史和隐私（点开）</summary>

- 账本在 `$DSH_HOME/storages/openai-subscription-meter/usage.json`，**只记调用事实和当时的报价**，不存提示词、不存回复内容、不存密钥。
- 设置在 `$DSH_HOME/plugin-state/openai-subscription-meter.json`，带版本号；两个标签页同时改，后写的会收到冲突提示而不是覆盖。
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
| `provider.defaultModel` | 默认模型，可以留空 |
| `provider.reasoningEffort` | 默认思考力度，可以留空 |
| `meter.*` | 用量模块的默认值，字段说明见插件自带的 `cordis.patch.yml` |

想调用量模块的细节（比如统计时区、是否读官方余额、保留多少天），在 profile 的 patch 层加一段 `meter:`，字段和默认值看插件自带的 [`cordis.patch.yml`](cordis.patch.yml)。**设置页里改的值存在插件状态文件里，优先级高于这里。**

字段类型写错（比如 `state: 5`）会在插件加载前就被拒绝，并在 DSH 启动输出里点名是哪个字段，而不是悄悄当成默认值——省得你对着「插件怎么不加载」发呆。

## 出问题时

### 模型列表报 `Model catalog request failed: fetch failed`

这是 Node.js 没能完成网络请求，**不是**登录失效。按顺序排查：

1. 在设置页重新刷新一次模型列表；
2. 确认跑 DSH 的那个 Node 进程能访问 `chatgpt.com`；
3. 检查代理规则放不放行 `chatgpt.com` 和 `auth.openai.com`；
4. 浏览器能上但 DSH 不能？看启动 DSH 的终端里 `HTTP_PROXY` / `HTTPS_PROXY` / TUN 路由配对了没；
5. 网络恢复后重启 profile，把页面上残留的旧错误清掉。

真是凭据失效的话，插件会直接说「需要重新登录」；上游返回异常时会带上 HTTP 状态码。看到那两种提示才需要去查登录状态。

### 改完代码，刷新浏览器没反应

Runtime 是 profile 加载的，改完要**重启 profile**，刷新页面不会重新加载。

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

`status` 之类的输出都会脱敏，OAuth token 和备份密码不会出现在里面。`doctor` 会顺带告诉你装的是哪个 DSH 版本、以及它满不满足插件声明的 `>=0.1.6-alpha.1`；读不到就写 `null`（**「不知道」不等于「通过」**），插件文件缺失时以非零码退出，可以直接当脚本门禁用。

## 和旧的 openai-codex 共存

插件发现旧的 `openai-codex` 之后**只报告状态**，不会自动搬凭据。想迁移的话，可以先用密码给旧凭据做个加密备份，再登录新的 `openai-subscription`。

两者凭据键和设置命名空间都不同，可以同时存在、按会话切换。当前会话用的是旧 Provider 时，本插件不会去查它的额度，也不显示。

## 已知限制

- ChatGPT / Codex 的非公开接口可能随时改协议或字段。
- 缓存命中率依赖上游上报 `cached_tokens`；不上报就没有这个数字（也不会假装是 0）。
- DeepSeek 费用是本地估算，价格是 2026-09-15 的公开价快照；跨价格档的请求按**开始时刻**取档。
- 自动纳入计量的 Provider **只记 token**。「还剩多少额度」和「多少钱」需要在 `src/usage/vendors.js` 里显式登记，新厂商的这个数字不会凭空出现。
- 账号类型靠你声明，插件不检测也不展示官方账单、发票或信用额度。
- 只统计本机这个 DSH 进程里的调用，同账号在别处的消耗不会进本地账本。

## 开发

```sh
npm test                  # 单元测试
npm run check             # 语法检查 + 全部单元测试
npm run test:e2e          # 真实 DeepSeek 余额查询；没有 Key 时会跳过
npm run test:integration  # 真实 DSH 组合 smoke（缺 DSH 依赖时跳过）
npm run test:headless     # 真实 dsh --profile headless --json 跑一遍（缺 dsh 时跳过）
npm run test:release      # 发布前跑：单元测试 + 两个 strict 门禁
```

`test:integration` 会把插件装进真实的 Cordis 上下文跑一次 `llm/stream`，验证它变成一条已计价记录，并且把结果送进 DSH 自己的流式校验器。`test:headless` 会真的启动一次 `dsh --profile headless --json`（在临时 DSH home 里，用一个 mock 模型路由，不联网），检查输出流是干净的 JSON、账本按会话记账。

这两个都需要本机装了 DSH，否则会跳过；加 `:strict` 或直接跑 `test:release` 就会把「跳过」当成失败——免得出现「因为没装 DSH 所以绿灯」的假通过。

<details>
<summary>代码大致在哪（点开）</summary>

```text
src/
  index.js / bootstrap.js   插件入口与安全引导
  runtime.js                装配：凭据、OAuth、额度、路由、adapter
  config.js / conflicts.js  配置校验与冲突检查
  rescue.mjs                上面那个 Rescue CLI
  oauth/                    登录流程（PKCE、设备码、回调）
  balance/  models/         额度查询、模型目录
  usage/                    用量账本、价格表、设置文件
  provider/                 把 DSH 的请求翻译成 Codex Responses，再翻译回来
  web/                      浏览器用的本地 API
client/
  client.js                 设置页、首次引导、侧边栏指示器
cordis.patch.yml            插件自带的默认配置层
```

</details>

## 许可证

MIT
