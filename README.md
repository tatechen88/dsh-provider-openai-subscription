# dsh-provider-openai-subscription

`dsh-provider-openai-subscription` 是面向 DeepSeek Harness（DSH）的独立 OpenAI / ChatGPT 订阅 Provider。插件使用 ChatGPT OAuth 凭据访问 Codex Responses 接口，并向 DSH 提供模型目录、流式生成、token 用量（含缓存命中）、订阅额度查询和 Web 设置界面。额度指示器默认停在侧边栏底部，也可以拖到页面任意位置。

> 本插件连接的是 ChatGPT / Codex 订阅所使用的非公开接口，不是 OpenAI Platform API。启用前，请自行确认账号、OAuth Client ID 和相关接口的使用风险。

## 效果预览

下面是插件在 DSH Web 设置页中的实际效果。截图中的账号信息已隐藏；左下角额度指示器的拖拽行为不在截图中，见 [Web 设置页](#web-设置页)。

![OpenAI ChatGPT OAuth Provider 在 DSH 设置页中的效果](docs/images/openai-subscription-preview.png)

## 功能

- 支持授权码、手动回调和设备码三种 ChatGPT OAuth 登录流程。
- 注册独立 Provider ID `openai-subscription`，不占用 `dsh-codex`、`dsh-codex-connect` 或 `llm-pi-ai/openai-codex` 的标识。
- 构造 OpenAI Responses 请求，并将 SSE 事件转换为 DSH 流式输出。
- 上报 token 用量，包括缓存命中（cached input）与 reasoning token，供 DSH 消息用量与统计使用。
- 查询模型目录，包括上下文窗口和 reasoning effort 信息；同时通过 DSH 的 model discovery 接缝（`llm.registerModelDiscovery`）把同一个目录提供给设置页的模型探测，两处共用一份来源。未登录时返回明确的拒绝原因，而不是会被读成「这个 Provider 没有模型」的空列表。
- 查询订阅额度，支持缓存、并发请求合并和过期数据回退。
- 内置用量与费用统计：指示器跟随当前模型在 OpenAI 订阅、DeepSeek 与智谱 GLM 之间切换，显示订阅额度、DeepSeek 官方余额、GLM Coding Plan 额度与资源包、本会话/今日/本月 token 与 DeepSeek 费用估算。**任何 DSH 已注册的 Provider 都自动纳入 token 计量**，新模型出现无需等插件更新；未定价的模型会被逐个点名，可选打开官方价格页自动更新。
- 在侧边栏底部显示用量与余额：**桌面宽度下直接显示文字**（DeepSeek 显示余额与今日消费，OpenAI 显示各额度窗口剩余百分比，GLM 显示资源包剩余 token 与今日用量）；**手机宽度或远程接入时自动收成一个柱状图图标**，点击才在图标上方展开数据卡片，卡片按视口夹取并换行，因此不会溢出屏幕。图标可拖拽到任意位置并记住位置，双击复位。数据卡片与拖出的浮动面板都挂在 `document.body` 上，不受侧边栏裁剪；卡片在无人操作 12 秒后自动收回，点击卡片之外、再点一次图标或按 Esc 也会立刻收回。
- 提供 DSH Web 设置页、首次启动引导、模型列表和退出登录功能，并在 **设置 → 模型** 的 Provider 卡片上提供同一套连接控件。首次启动引导按 DSH 的 `settings.onboarding` 约定拥有自己的模态外壳：显示期间把 `#root` 设为 `inert`，把焦点移入对话框并在其中循环，关闭时把 inert 状态与焦点交还给原处；它是阻塞步骤，只能通过明确的「稍后」按钮离开，Esc 不会隐式关闭。
- 检测旧 `openai-codex` Provider，并支持对旧凭据创建加密备份。
- 提供 Rescue CLI，可查看状态、启用或禁用插件、管理快照以及执行安装检查。
- 组合与引导阶段永不阻止 DSH 启动：默认的 `bootstrap` 状态不加载任何 Runtime。

## 兼容性

| 目标 | 版本 |
| --- | --- |
| DSH | `>=0.1.6-alpha.1`（`package.json` 的 `engines.dsh`） |
| Node.js | `^22.19.0 \|\| >=24.0.0` |

本版本针对 DSH 0.1.6 的接口调整过：流式输出补齐了 `block-start` / `block-end` 语法，Provider 请求改用 DSH 的 `attributionHeaders()`（`User-Agent` 形如 `deepseek-harness/<版本> (+仓库地址)`），激活失败改由 DSH 自身的 optional entry 机制上报。更早的 DSH 版本未经验证。

因为本插件常以 `link:` 方式装进 profile，模块真实路径在 profile 之外，「向上一层找 `node_modules`」这条常规解析路径到不了 harness 包；插件会按「自身路径 → `$DSH_HOME/profiles/node_modules` → `profiles/web/node_modules` → `node_modules`」依次尝试，取到官方 helper 就用它，全都取不到才回落到带版本号的插件自身身份。

## 安全加载

插件遵循一个简单原则：插件自身可以停用，但配置或引导阶段的任何问题都不能阻止 DSH 启动。

Cordis 启动时只加载 `src/index.js` 和 `src/bootstrap.js`。只有同时满足以下条件，插件才会动态加载 Runtime：

- `state` 设置为 `active`；
- `oauth.clientId` 已配置且不为空；
- 未通过 Rescue CLI 启用 kill switch。

`bootstrap`、`disabled` 和 kill switch 是正常的「不激活」：插件正常完成加载，不贡献任何 Provider。

显式声明 `state: active` 却无法激活时（缺少 `oauth.clientId`、Runtime 导入失败、缺少 DSH 服务、Provider 或设置命名空间冲突），`apply()` 会以 rejected Promise 结束，把真实原因交给 DSH 的启动审计：

- DSH 会把本条目作为 **optional entry** 记录一条启动警告，**其余插件照常运行**，DSH 不会被阻止启动；
- 失败原因出现在 DSH 的启动输出里，而不是只留在插件自己的日志里；
- 部分完成的注册（Adapter、模型目录条目、HTTP 路由）会被逆序回滚，不会留下无人释放的残留。

因此判断标准不是「插件有没有失败」，而是「失败会不会挡住 DSH」。即使 DSH 本身无法进入 Web 设置页，也可以通过独立的 Rescue CLI 禁用插件。

## 安装与激活

在 DSH 源码目录或已经安装 DSH 的环境中添加插件：

```sh
dsh plugin --profile web add ../dsh-provider-openai-subscription
```

安装后，插件默认处于 `bootstrap` 状态，不会加载 Runtime。确认配置无冲突后，编辑该 profile 的激活层 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`，把整个文件内容换成：

> **这个文件出厂是一段注释加一个占位 `[]`。必须把 `[]` 替换成下面的内容，不要在 `[]` 后面追加。**
> `[]` 之后跟一个块序列不是合法 YAML：DSH 会报 `failed to parse overlay ...` 并拒绝组合该 profile，表现是整个 profile 起不来。`dsh-openai-subscription-rescue doctor --profile .../package.json` 会识别这种写法并给出提示。

```yaml
- id: llm-openai-subscription
  name: dsh-provider-openai-subscription
  config:
    state: active
    oauth:
      clientId: "<your-client-id>"
    provider:
      defaultModel: ""
      reasoningEffort: ""
    meter:
      accountKind: unknown      # unknown | personal | enterprise
      displayCurrency: CNY
      timeZone: system          # system | UTC | Asia/Shanghai
      deepseekBalance: true     # 读取 DeepSeek 官方余额；关掉则完全不发该请求
      autoProviders: true       # 所有已注册 Provider 都记 token；关掉只记注册表里的厂商
      refreshPublicPrices: false # 读官方价格页给新模型定价；默认关，见「新模型怎么自己出现」
      retentionDays: 90         # 90 天前的原始调用折叠成按日汇总；0 = 永不折叠
      hideBalance: false
      hideCost: false
      contractualSchedules: []  # 企业合同价，见「企业合同价」一节
```

`meter` 是内置用量模块的默认层，上面这段与插件自带 patch 层的默认值一致：`meter` 整块省略也能工作（每个字段各自回落到内置默认），写出来只是让部署意图显式。运行时的设置页保存到 `$DSH_HOME/plugin-state/openai-subscription-meter.json`，该文件优先级高于这里的默认层。完整字段说明见「用量与费用（内置 meter）」。

重新启动对应的 DSH profile，然后在 Web 设置页完成 ChatGPT OAuth 登录。

### 验证安装

三步都能独立确认，不必等到点开设置页：

```sh
# 1）组合树里应出现插件行，激活后 state 为 active（Windows 用 Select-String -Context 0,2）
dsh --profile web --dump-config | grep -A2 llm-openai-subscription

# 2）依赖 / bundle / 激活层一致性检查，离线运行、不加载 Runtime
dsh-openai-subscription-rescue doctor --profile "$DSH_HOME/profiles/web/package.json"

# 3）在临时 DSH_HOME 里完整重放「初始化 → 安装 → 组合 → 激活」，不碰真实 profile
npm run test:install
```

如需立即停用插件，可以运行：

```sh
dsh-openai-subscription-rescue disable
```

## 配置

| 字段 | 说明 |
|---|---|
| `state` | 可选值为 `bootstrap`、`disabled` 或 `active`。只有 `active` 会加载 Runtime。 |
| `oauth.clientId` | OAuth Client ID。留空时不加载 Runtime。 |
| `provider.defaultModel` | 默认模型 ID，可以留空。 |
| `provider.reasoningEffort` | 默认 reasoning effort，可以留空。 |
| `meter.*` | 内置用量模块的默认层；设置页里改的值存在插件状态文件中并覆盖这里。 |

插件使用独立的 Provider ID、设置命名空间和凭据键，不会覆盖旧 `openai-codex` Provider 的配置或凭据。

插件向 DSH 导出一个 `Config` schema（无依赖手写的 Standard Schema，同步校验）。**已知字段写错类型会被 DSH 在 `apply()` 之前拒绝**，并在启动审计里点名具体字段——例如 `state: 5` 以前会被静默当成 `bootstrap`（表现是插件莫名其妙不加载），现在直接报错。未知的顶层键与 `meter` 下的任意字段仍然放行，因为向前兼容依赖容忍这个版本还不认识的配置。

## Web 设置页

Runtime 激活后，插件会在 DSH Web 客户端注册设置入口。登录成功后，可以在页面中查看：

- 当前 ChatGPT 账号；
- 订阅方案与额度窗口；
- 上游返回的模型目录；
- 默认模型和 reasoning effort 配置；
- 旧 Provider 的检测与备份状态。

同一套连接控件也出现在 **设置 → 模型** 里本插件所属的 Provider 卡片上（DSH 0.1.6 的 `settings.models.provider-card`，按设置命名空间 `llm-openai-subscription` 分发）。因此不必先找到插件的独立设置页才能登录或退出；卡片只保留连接相关的控件，用量与费用的配置表单仍然只在插件自己的设置页上，不会出现两处编辑同一份设置。

左下角的额度指示器可以拖拽到页面任意位置，双击复位；拖动后按自身文本自适应宽度，完整显示额度内容，位置保存在浏览器本地。恢复位置、拖动结束或窗口变小时，指示器会避让该位置已有的可交互 UI，并自动收回可见区域。

侧边栏底部是所有 footer 操作共享的一行，不是指示器独占的整行（`dsh-cost-meter` 等插件也注册在同一席位）。选中 OpenAI 订阅 Provider、指示器出现时，它会让该行可以换行，并把自己排在其它操作之前、独占一整行，因此显示在已有 UI 的上方，而不是和它们挤在同一行或覆盖它们。指示器浮出、或该 Provider 不再被选中后，这一行的布局会恢复原状。

浏览器只访问插件注册的本地同源路由。OAuth token、额度请求和模型请求均由 DSH Runtime 发往上游接口。

这些路由默认由 **DSH 自己的 Connection 策略**把关：先做 Host/Origin 栅栏（挡住 DNS rebinding——只比较 `Origin` 与 `Host` 的旧写法挡不住它），再校验浏览器会话 Cookie（`HttpOnly; SameSite=Strict`，因此跨站请求拿不到它）。部署里没有 Connection 服务时（例如更精简的 profile），才回落到插件自带的同源比较。

路由的生命周期绑定在 Web 服务本身上：激活时 Web 服务已在，就同步挂载；尚未出现（兄弟插件还在加载，或端口绑定失败等待恢复），则改为注入等待——Web 服务一出现就挂上，被替换或撤下时自动释放。因此**可选的 Web 服务不会让激活空等**（实测 1 ms 内完成），也不会出现「启动时没赶上就永远没有路由」。

## Token 用量与缓存命中

Responses 的终止事件会携带 `usage`，插件在 finish 之前把它转换为 DSH 的用量块：

- OpenAI 的 `input_tokens` **包含**缓存命中，而 DSH 的 `inputTokens` 是**不含缓存**的口径，因此插件上报 `inputTokens = input_tokens - cached_tokens`，并把 `cached_tokens` 单独作为 `cacheReadTokens`；
- `output_tokens_details.reasoning_tokens` 映射为 `reasoningTokens`；
- 始终附带精确的 `totalTokens`（`input_tokens + output_tokens`）。DSH 只在存在总额时接受"只有缓存读取、没有缓存写入"的用量，缺少总额会导致整条用量被丢弃；
- 上游**未上报** `cached_tokens` 时省略该字段，而不是伪造为 0；上报了 `cached_tokens: 0` 时保留 0，因为"未上报"和"确认零命中"是两个不同事实；
- 缓存数大于输入总数、reasoning 大于输出总数、非整数等不可能取值的明细会被丢弃，避免负的 prompt 计数。

转换后的用量会出现在 DSH 消息的 token 用量显示（Cached input / 缓存读取）中，并作为一条事实进入本插件的账本。

用量转换位于 Host 侧，升级插件后需要重新启动对应 DSH profile 才会生效。

## 用量与费用（内置 meter）

插件自身就是一个用量与费用模块，不再需要额外安装 `dsh-cost-meter`。它监听 DSH 的全局 `llm/stream`，把每次模型调用最终上报的 usage 记成一条事实，再用带版本的价格表估算费用。

### 指示器跟随模型切换

侧边栏底部只有一个指示器，按视口宽度自动选一种渲染：**桌面宽度下直接显示数字**（不用点）；**手机宽度或远程接入时收成一个柱状图图标**，点击图标才在它上方展开数据卡片（Esc、再点一次、或卡片上的 × 都能收起）。卡片按视口宽度夹取并换行，因此在窄屏下不会溢出屏幕。两种渲染的内容都按当前会话选中的 Provider 切换：

卡片和拖出来的浮动面板都渲染在 `document.body` 上，而不是留在侧边栏里：侧边栏会裁剪自己的子树（收起/展开时带动画的祖先同时是包含块），留在里面的话即使写了 `position: fixed` 也会被切在侧边栏右边缘。卡片无人操作 12 秒后自动收回；点卡片外、再点图标、按 Esc，或切换模型都会立即收回——切换模型后若还留着旧卡片，显示的就是上一个账号的数字。

| 当前 Provider | 桌面显示 / 卡片里的数据 |
|---|---|
| `openai-subscription` | 桌面：`OpenAI 5小时 82% · 每周 64%`；卡片：`OpenAI (ChatGPT OAuth)`、各窗口剩余百分比、本会话/今日/本月 token |
| `deepseek-official` | 桌面：`DeepSeek ¥86.20 · 今日 ¥0.42`（余额 + 今日消费）；卡片：再加上账号类型、月消费、价格来源 |
| `zai-coding-cn`（智谱 GLM） | 桌面：`GLM 余 14M · 今日 1.2M`（资源包剩余 token + 今日用量）；卡片：Coding Plan 各窗口剩余额度、现金余额、每个资源包（名称、剩余量、模型范围、到期日）、本会话/今日/本月 token（含思考 token）、会话按模型分解 |
| 其他已注册 Provider | 桌面：`<provider id> 今日 3.4M`；卡片：该路由的 token 与未定价模型。没有账号读数就不显示余额，没有价格表就不显示金额 |
| 未注册的 Provider | 不显示 |

卡片还有三行与"钱什么时候最少"有关：**当前价格档**（`高峰时段 · 42 分钟后转空闲时段（半价）`，倒计时来自官方时段定义）、**思考 token**（`输出 20.0K（含思考 12.0K）`，它是输出的子集不重复计费）、以及**会话按模型分解**（`会话构成: glm-5.3 1.2M→30.0K · …`，最多三个最重的模型）。

鼠标悬停在任何一种渲染上都会给出同一份数据的单行摘要，两份内容来自同一个函数，不会互相矛盾。

悬停还会说明这条金额是按**公开价**还是**合同价**估算的：只有账号已声明为企业、合同在有效期内时才会写「合同价」并给出合同名，否则一律写「公开价 + 快照日期」。

切换 Provider 时同一个节点就地换内容；每次请求都带着发起时的 Provider 代号，迟到的响应会被丢弃，因此快速来回切换不会让旧账号的金额覆盖新账号。

输入框下方另有一行会话用量：OpenAI 显示 token 与缓存命中率，DeepSeek 追加本会话的估算费用，GLM 只显示 token 与缓存命中率。

### 智谱 GLM 账号读数

GLM 走 pi-ai 的 `zai-coding-cn` 路由，用量与资源包也从智谱自己的账号接口读：

- 凭据与 pi-ai 共用一份：先取设置里 `llm-pi-ai.providers['zai-coding-cn'].apiKeyEnv` 指定的变量名，再回落到 `ZAI_CODING_CN_API_KEY`，最后读进程环境；插件不新增凭据配置项。
- 中国站（`open.bigmodel.cn`）的用量端点用**原始 Key**，其余端点用 `Bearer`；国际站（`api.z.ai`）是另一条路由、另一份凭据引用，未单独配置时不会显示。
- 「当前用户不存在 coding plan」是**业务性拒绝**（HTTP 200 + `code:500`），卡片照抄官方措辞，不用 0% 或"未配置"掩盖。
- 读数 5 分钟内复用缓存；某个端点失败只影响它自己那条，卡片写「部分数据不可用」，并保留上一次成功的读数。
- 资源包只统计 `EFFECTIVE` 状态的包：`TOKENS` 包算 token，`TIMES` 包算次（图片/视频、搜索）。

### 新模型怎么自己出现

模型换得比插件版本快，所以"哪些 Provider、哪些模型要统计"不写死在代码里：

- **任何 DSH 已注册的 Provider 都自动纳入计量**（token 口径），不需要改代码或等新版本：你换到一个别的插件刚注册的模型，它的 token 立即进账本，指示器按它自己的名字显示。没有账号读数就不显示余额，没有价格表就不显示金额——**不会借用别的厂商的数字**。
- **数字按 Provider 归属**：切到哪个模型就看哪个 Provider 的「本会话/今日/本月」，别家的 token 不会混进来。
- **未定价的模型会被点名**：卡片与 `rescue meter` 会列出「未配置价格: deepseek-v5 ×3」这样的行——这是新模型刚发布、内置快照还没有它的费率时的样子。
- **OpenAI 订阅的模型目录**每 10 分钟自动重新拉取一次，页面上的「刷新」按钮也会真正清掉缓存重拉，因此新模型不需要重启。
- **可选：让价格表自己去官方页更新。** 打开 `meter.refreshPublicPrices` 后，一旦出现内置快照没有的 DeepSeek 模型，插件会在后台读一次[官方价格页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)，把整张表解析出来（含页面自己写明的高峰时段与旧模型别名），存到 `$DSH_HOME/storages/openai-subscription-meter/prices.json`，下次调用就按新表计价。默认关闭：这是本插件唯一一个与账号状态无关的外发请求。

价格表自动刷新有三条硬规则：**整表解析成功才采用**（任何一行读不出来就整张丢弃，继续用旧表，并把原因记在卡片上）；**绝不编价**（页面没写的费率不会推算，也不会拿别的模型的价格顶替）；**改表不改历史**（每条已记录的调用都保存当时用的价格表 ID）。

### 费用口径

- **OpenAI 订阅不显示金额。** ChatGPT 订阅没有按 token 的现金结算，把 API 目录价当成订阅支出是错的。
- **GLM 只计量不计价。** 智谱 Coding Plan 是订阅制，没有可引用的按 token 价格，因此 GLM 调用始终记为「未配置价格」（`no-schedule`）：只累计 token，既不产生金额，也不会套用 DeepSeek 的价格表。
- **DeepSeek 显示的是本地估算。** 官方公开接口只提供余额，没有账单历史；费用由本插件按 token 与价格表计算，措辞与 UI 始终标注"估算"。
- **账本会自动压实。** 超过 `meter.retentionDays`（默认 90 天，0 = 永不）的原始调用，在启动时折叠成"每天 × 每路由 × 每模型"的汇总条目：token 与金额都是整数求和，**所有时间窗的合计一分不差**；换来的是账本文件有界、不会随年月膨胀。会话级明细的回溯范围即这个窗口。
- 计价使用**整数定点**：价格以「每百万 token 的货币微元」存储，金额是各桶分子求和后一次性四舍五入，不经过浮点累加。
- 三个计费桶：未缓存输入、缓存读取、输出。`reasoning` 是输出的子集，只展示不重复计费。官方未公布独立的 cache-write 价格，因此该桶只统计、不计费。
- 未知模型**不套默认价**，显示为"未配置价格"，避免用别的模型价格编造金额；这类模型会在卡片与 `rescue meter` 里被逐个点名。
- 价格带版本：当前内置 DeepSeek 公开价快照（2026-09-15，含阶梯时段），每条记录都保存当时采用的价格表 ID，改价不会改写历史。打开 `meter.refreshPublicPrices` 后，官方页读到的表会排在快照之前，快照继续为它没有覆盖的模型兜底。

### 账号类型与企业合同价

账号类型是**用户声明**，不是检测结果：DeepSeek 公开 API 不返回实名类型，官方 FAQ 也说明个人与企业当前在产品功能和权益上无差异，差异主要在认证流程、对公充值与发票抬头。

- 设置页可选 `未声明 / 个人 / 企业（用户声明）`；
- 只有声明为企业、且配置了在有效期内、模型匹配的合同价时，合同价才生效；
- 企业身份本身不会自动产生折扣；没有有效合同价时回退到公开价估算；
- UI 会显示实际采用的是"公开价"还是"合同价"，以及合同表名称与有效期。

合同价在设置页选择「企业」后出现，是一个 JSON 数组：

```json
[
  {
    "id": "acme-2026",
    "label": "Acme agreement",
    "currency": "USD",
    "validFrom": "2026-01-01",
    "validTo": "2026-12-31",
    "models": {
      "deepseek-flash": { "cacheMiss": 0.1, "cacheHit": 0.001, "output": 0.2 }
    }
  }
]
```

单价是**每百万 token 的货币金额**（与官方价目表同一口径），三项缺一不可；缺项的条目会被整条丢弃，而不是按 0 计费。JSON 写坏时保存按钮禁用并就地报错。

### 从 dsh-cost-meter 迁移

内置 meter 与 `dsh-cost-meter` 会计量同一批调用，因此不要长期同时启用。

1. 在目标 profile 的 `package.json` 中，从 `dependencies` 与 `dsh.profile.bundles` 两处移除 `dsh-cost-meter`；
2. 如果该 profile 的 `pnpm-workspace.yaml` 里有指向它的 `patchedDependencies`，一并移除——否则下一次 `pnpm install` 会因为补丁找不到目标包而失败（补丁文件本身可以留着）；
3. 重启 profile。启动时 DSH 只解析 `bundles` 列表，不再解析的包不会被读取，因此残留的 `node_modules/dsh-cost-meter` 不影响启动；
4. 旧账本 `$DSH_HOME/storages/cost-meter/ledger.json` 不会被读取、修改或删除，需要归档时自行移动；
5. 想回滚就重新安装并启用 `dsh-cost-meter`，本插件的账本保留不动。

想先确认改完的组合还能加载，可以在不启动服务的情况下打印组合结果：

```sh
dsh --profile web --dump-default-config
```

它只加载 bundle 层、不读用户 patch 层，所以输出里的 `state` 仍是 bundle 默认值 `bootstrap`，这不代表运行时未激活。

### 数据与隐私

- 账本位于 `$DSH_HOME/storages/openai-subscription-meter/usage.json`，只保存调用事实与当时报价，不保存提示词、响应正文或密钥；
- 设置位于 `$DSH_HOME/plugin-state/openai-subscription-meter.json`，带 revision，冲突写入返回 409 而不是覆盖；
- 从官方页学到的价格表位于 `$DSH_HOME/storages/openai-subscription-meter/prices.json`：它是派生数据，删掉只会让内置快照重新接管计价，不影响账本；
- 余额查询每次重新解析 `DEEPSEEK_API_KEY`（或 `llm-deepseek.apiKeyEnv` 指定的变量），只允许发往 HTTPS `api.deepseek.com`，禁止重定向；失败保留上一次成功读数；
- 价格页请求不携带任何凭据（那是公开文档页），同样禁止重定向，超时覆盖响应体；
- 设置页的「用量与费用」面板只提供**显示币种**（人民币 / 美元）；账号类型、统计时区、是否读取官方余额、是否自动纳入所有已注册 Provider、是否读官方价格页、隐藏余额与隐藏费用都在 `cordis.patch.yml` 的 `meter` 配置层，token 统计不受这些开关影响。

## DSH 工具权限

Provider 会把 DSH 工具 schema 转换为模型可用的 Responses 工具定义。普通参数保持不变，但不会向模型暴露 `sandbox_permissions` 和 `justification`。

这两个字段由 DSH 的审批和权限系统管理，用于对单次工具调用进行严格的权限加宽。它们不是普通业务参数。在会话已经处于 `danger-full-access` 时，继续申请同级权限会被 DSH 以 `not strictly wider` 拒绝，模型可能因此重复提交相同请求。隐藏这些字段后，模型无法进入该重试循环。若命令被受限文件策略拒绝，模型应提示用户切换 DSH 权限预设。

相关实现位于 `src/provider/request-builder.js` 的 `buildResponsesTools`。

## Rescue CLI

Rescue CLI 不依赖插件 Runtime，可在 Web 设置页或 DSH 启动异常时单独运行。

```sh
# 查看脱敏状态
dsh-openai-subscription-rescue status

# 只读检查内置 meter 的落盘状态（ledger schema 版本与事实条数、未定价模型清单、设置 revision、新旧 ledger 是否并存）
dsh-openai-subscription-rescue meter

# 检查依赖和激活条件
dsh-openai-subscription-rescue doctor --profile path/to/profile/package.json
# 创建或回滚快照（rollback 需要 --target；快照目录默认在 plugin-state 下）
dsh-openai-subscription-rescue snapshot --profile "$DSH_HOME/profiles/web/package.json" --patch "$DSH_HOME/profiles/web/cordis.patch.yml"
dsh-openai-subscription-rescue rollback --path "$DSH_HOME/plugin-state/openai-subscription-snapshots" --target "$DSH_HOME/profiles/web/package.json"

# 启用或禁用插件
dsh-openai-subscription-rescue enable
dsh-openai-subscription-rescue disable
```

所有状态输出都会脱敏。OAuth access token、refresh token 和备份密码不会写入日志或状态响应。

`doctor` 输出带 `schemaVersion` 的 JSON，并在最后给出 DSH 兼容性判定：

```json
{
  "schemaVersion": 1,
  "compatibility": {
    "declaredDshRange": ">=0.1.6-alpha.1",
    "installedDsh": "0.1.6-alpha.1",
    "satisfied": true
  }
}
```

`installedDsh` 是从 profile 的 `node_modules/@deepseek-ai/dsh/package.json` 读到的，不会去启动 DSH。读不到时两项都是 `null`——**未知不等于通过**。只要插件文件缺失，`doctor` 会以非零码退出，因此可以直接用作脚本门禁。

## 迁移与共存

插件发现旧 `openai-codex` Provider 后只报告状态，不会自动复制、删除或刷新旧凭据。需要迁移时，可以先用密码创建旧凭据的加密备份，再登录新的 `openai-subscription` Provider。

新旧 Provider 使用不同的凭据键和设置命名空间，可以同时存在并按会话切换。当前会话使用旧 Provider 时，本插件不会查询或显示 `openai-subscription` 的额度，客户端和桌面壳也不会为它请求上游额度接口。

## 常见问题

### 模型目录提示 `Model catalog request failed: fetch failed`

这条错误表示 Node.js 在收到 HTTP 响应前未能完成网络请求。它通常与 DNS、TLS、代理、VPN 或 TUN 网络状态有关，并不等同于 OAuth 凭据失效。

可以按以下顺序检查：

1. 在设置页重新刷新模型目录；
2. 确认运行 DSH 的 Node.js 进程可以访问 `chatgpt.com`；
3. 检查代理规则是否允许访问 `chatgpt.com` 和 `auth.openai.com`；
4. 如果浏览器可以访问但 DSH 不行，检查启动 DSH 的终端是否配置了正确的 `HTTP_PROXY`、`HTTPS_PROXY` 或 TUN 路由；
5. 网络恢复后重启对应的 DSH profile，清除页面中保留的旧错误状态。

凭据被拒绝时，插件会返回需要重新登录的明确错误；上游返回异常状态时，错误中会包含 HTTP 状态码。只有看到这些提示时，才需要优先检查登录状态或上游接口。

### 修改源码后，刷新浏览器仍未生效

Runtime 由 DSH profile 加载。修改源码后需要重新启动对应 profile，仅刷新浏览器页面不会重新加载 Runtime。

## 开发与测试

```sh
npm test                  # 运行全部单元测试
npm run check             # 语法检查并运行全部单元测试
npm run test:e2e          # 真实 DeepSeek 余额查询；没有 Key 时安全跳过
npm run test:integration  # 真实 DSH 组合 smoke：装进真实 Cordis 上下文驱动一次 llm/stream，
                          # 验证它变成一条已计价账本记录；缺少 DSH 依赖时安全跳过
npm run test:integration:strict   # 同上，但缺 DSH 依赖直接判失败（发布门用）
npm run test:install:strict       # 安装流程 smoke，缺 dsh / pnpm 直接判失败（发布门用）
```

`test:integration` 除了计量路径，还会挂载 DSH 自己的 `llm/stream` 校验器，先用一段**非法**流证明校验器确实生效，再把本插件 adapter 的真实 SSE 翻译结果送进同一校验器。因此它同时证明了两件事：插件输出的 chunk 语法被 DSH 0.1.6 接受，以及这条断言本身不是空跑。

发布前用 `npm run test:release`（单元测试 + strict 组合检查），避免「因为本机没装 DSH 所以绿灯」的假通过。

插件自带一套深色界面，但颜色全部取自 DSH 主题的语义别名（`var(--dsw-alias-*)`），因此浅色主题下会跟着变。`test/client-theme-tokens.test.mjs` 是源码级护栏：一旦有人在客户端包写回字面颜色，或者自己写主题分支，测试立刻失败。

`test/headless-stdout.test.mjs` 守住另一条：插件在 DSH 进程内被加载时不会写 stdout（`dsh --profile headless --json` 的 stdout 是机器可读事件流，只能由 DSH 自己写）。插件内部一律走 DSH 的 logger，只有独立的 Rescue CLI 才打印到 stdout。

`npm run test:headless` 跑的是**真实的 `dsh --profile headless --json`**：在一个临时 DSH home 里（`profiles/node_modules` 用链接借用已安装的 harness，不联网、不装包）插入一个 mock 模型路由，然后断言 stdout 每一行都是合法 JSON 事件、流以 `session` 开头以 `final` 结束、账本按该 session 记账，以及同一 session 的第二次运行只追加自己的调用而不重复。它需要 `dsh` 在 PATH 上，否则跳过；`--require-dsh` 把跳过变成失败。`npm run test:release` 会一并跑单元测试、strict 组合检查与 strict headless smoke。

## 目录结构

```text
src/
  index.js                 Cordis 插件入口
  bootstrap.js             安全引导：区分「正常不激活」与「激活失败」
  runtime.js               Runtime 装配，包括凭据、OAuth、额度、路由和 adapter；注册失败会逆序回滚
  config.js                配置归一化与激活判断
  state.js                 DSH_HOME 下的 kill switch 状态
  conflicts.js             Provider、设置命名空间与 configurable provider 冲突检查
  rescue.mjs               Rescue CLI
  credentials/             凭据 schema、repository 和 token manager
  oauth/                   PKCE、state、JWT、callback 和 device code
  balance/                 额度客户端、响应归一化与缓存服务
  models/                  模型目录客户端
  usage/
    types.js               用量事实模型与校验
    pricing.js             定点价格表、阶梯时段与报价
    collector.js           llm/stream 计量监听器
    ledger.js              持久化账本与聚合
    deepseek-balance.js    DeepSeek 官方余额客户端与端点门禁
    config.js              设置归一化与企业合同价解析
    settings-store.js      带 revision 的插件设置文件
    service.js             统一视图模型
  provider/
    attribution.js         请求归属头：优先使用 DSH 的 attributionHeaders()
    request-builder.js     Responses 请求构造与工具 schema 转换
    adapter.js             OpenAI 订阅 Provider adapter
    event-translator.js    Responses SSE 到 DSH chunk 与 token 用量的转换
  stream/                  SSE parser
  web/                     本地同源 Web API 路由
client/
  client.js                设置页、首次启动引导、统一用量指示器、会话用量行与拖拽
test/                      Node.js 单元测试（*.e2e.mjs 为需要真实凭据的端到端）
cordis.patch.yml           DSH bundle patch 定义，含 meter 默认层
```

## 已知限制

- OAuth、模型目录和额度接口的完整验证需要真实账号及明确授权。
- ChatGPT / Codex 非公开接口可能随时调整协议或返回字段。
- 缓存命中依赖上游在 `usage.input_tokens_details.cached_tokens` 中上报；未上报时不会显示命中率。
- DeepSeek 费用是本地估算：价格来自 2026-09-15 的公开价快照，跨阶梯时段的请求按**请求开始时刻**取档，官方未公开实际结算规则。打开 `refreshPublicPrices` 后价格表会从官方页更新，但页面结构一变就会整表拒用并回退到快照，此时新模型会停在「未配置价格」。
- 自动纳入的 Provider 只记 token：账号读数（余额、套餐）与价格表仍需在 `src/usage/vendors.js` 里显式登记，因此新厂商的「还剩多少」不会凭空出现。
- 账号类型无法自动识别，企业身份始终是用户声明；插件不读取也不展示官方账单、发票或信用额度。
- 智谱 GLM 的额度窗口类型（`TOKENS_LIMIT` / `TIME_LIMIT`）来自官方接口，插件只呈现上报值；该条读数失败时显示为不可用，不用 0 代替。
- 只统计本 DSH 进程内的调用；同账号在其他机器或客户端上的消耗不会进入本地账本。
- 高级模型配置 UI 尚未覆盖 Provider 的全部参数。

## 许可证

MIT
