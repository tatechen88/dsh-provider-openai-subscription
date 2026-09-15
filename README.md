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
- 查询模型目录，包括上下文窗口和 reasoning effort 信息。
- 查询订阅额度，支持缓存、并发请求合并和过期数据回退。
- 内置用量与费用统计：指示器跟随当前模型在 OpenAI 订阅与 DeepSeek 之间切换，显示订阅额度、DeepSeek 官方余额、本会话/今日/本月 token 与 DeepSeek 费用估算。
- 在侧边栏底部显示额度指示器，可拖拽到任意位置并记住位置；恢复、拖动结束或窗口变化时避让该位置已有的 UI。
- 提供 DSH Web 设置页、首次启动引导、模型列表和退出登录功能。
- 检测旧 `openai-codex` Provider，并支持对旧凭据创建加密备份。
- 提供 Rescue CLI，可查看状态、启用或禁用插件、管理快照以及执行安装检查。
- 使用安全 Bootstrap。插件加载失败时，DSH 仍可继续启动。

## 安全加载

插件遵循一个简单原则：插件自身可以停用，但不能因为加载失败而阻止 DSH 重启。

Cordis 启动时只加载 `src/index.js` 和 `src/bootstrap.js`。只有同时满足以下条件，插件才会动态加载 Runtime：

- `state` 设置为 `active`；
- `oauth.clientId` 已配置且不为空；
- 未通过 Rescue CLI 启用 kill switch。

Runtime 加载或初始化失败时，Bootstrap 会捕获错误并停止激活插件，不会把异常继续抛给 DSH Loader。即使 DSH 本身无法进入 Web 设置页，也可以通过独立的 Rescue CLI 禁用插件。

## 安装与激活

在 DSH 源码目录或已经安装 DSH 的环境中添加插件：

```sh
dsh plugin --profile web add ../dsh-provider-openai-subscription
```

安装后，插件默认处于 `bootstrap` 状态，不会加载 Runtime。确认配置无冲突后，在对应 profile 中显式激活：

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
```

重新启动对应的 DSH profile，然后在 Web 设置页完成 ChatGPT OAuth 登录。

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

插件使用独立的 Provider ID、设置命名空间和凭据键，不会覆盖旧 `openai-codex` Provider 的配置或凭据。

## Web 设置页

Runtime 激活后，插件会在 DSH Web 客户端注册设置入口。登录成功后，可以在页面中查看：

- 当前 ChatGPT 账号；
- 订阅方案与额度窗口；
- 上游返回的模型目录；
- 默认模型和 reasoning effort 配置；
- 旧 Provider 的检测与备份状态。

左下角的额度指示器可以拖拽到页面任意位置，双击复位；拖动后按自身文本自适应宽度，完整显示额度内容，位置保存在浏览器本地。恢复位置、拖动结束或窗口变小时，指示器会避让该位置已有的可交互 UI，并自动收回可见区域。

侧边栏底部是所有 footer 操作共享的一行，不是指示器独占的整行（`dsh-cost-meter` 等插件也注册在同一席位）。选中 OpenAI 订阅 Provider、指示器出现时，它会让该行可以换行，并把自己排在其它操作之前、独占一整行，因此显示在已有 UI 的上方，而不是和它们挤在同一行或覆盖它们。指示器浮出、或该 Provider 不再被选中后，这一行的布局会恢复原状。

浏览器只访问插件注册的本地同源路由。OAuth token、额度请求和模型请求均由 DSH Runtime 发往上游接口。

## Token 用量与缓存命中

Responses 的终止事件会携带 `usage`，插件在 finish 之前把它转换为 DSH 的用量块：

- OpenAI 的 `input_tokens` **包含**缓存命中，而 DSH 的 `inputTokens` 是**不含缓存**的口径，因此插件上报 `inputTokens = input_tokens - cached_tokens`，并把 `cached_tokens` 单独作为 `cacheReadTokens`；
- `output_tokens_details.reasoning_tokens` 映射为 `reasoningTokens`；
- 始终附带精确的 `totalTokens`（`input_tokens + output_tokens`）。DSH 只在存在总额时接受"只有缓存读取、没有缓存写入"的用量，缺少总额会导致整条用量被丢弃；
- 上游**未上报** `cached_tokens` 时省略该字段，而不是伪造为 0；上报了 `cached_tokens: 0` 时保留 0，因为"未上报"和"确认零命中"是两个不同事实；
- 缓存数大于输入总数、reasoning 大于输出总数、非整数等不可能取值的明细会被丢弃，避免负的 prompt 计数。

转换后的用量会出现在 DSH 消息的 token 用量显示（Cached input / 缓存读取）与 `dsh-cost-meter` 的统计中。

用量转换位于 Host 侧，升级插件后需要重新启动对应 DSH profile 才会生效。

## 用量与费用（内置 meter）

插件自身就是一个用量与费用模块，不再需要额外安装 `dsh-cost-meter`。它监听 DSH 的全局 `llm/stream`，把每次模型调用最终上报的 usage 记成一条事实，再用带版本的价格表估算费用。

### 指示器跟随模型切换

侧边栏底部只有一个指示器，按当前会话选中的 Provider 切换内容：

| 当前 Provider | 显示 |
|---|---|
| `openai-subscription` | `OpenAI 5小时 82% · 每周 64%`，悬停见本会话 token |
| `deepseek-official` | `DeepSeek ¥86.20 · 今日 ¥0.42`，悬停见账号类型、价格来源与估算口径 |
| 其他 | 不显示 |

切换 Provider 时同一个节点就地换内容；每次请求都带着发起时的 Provider 代号，迟到的响应会被丢弃，因此快速来回切换不会让旧账号的金额覆盖新账号。

输入框下方另有一行会话用量：OpenAI 显示 token 与缓存命中率，DeepSeek 追加本会话的估算费用。

### 费用口径

- **OpenAI 订阅不显示金额。** ChatGPT 订阅没有按 token 的现金结算，把 API 目录价当成订阅支出是错的。
- **DeepSeek 显示的是本地估算。** 官方公开接口只提供余额，没有账单历史；费用由本插件按 token 与价格表计算，措辞与 UI 始终标注"估算"。
- 计价使用**整数定点**：价格以「每百万 token 的货币微元」存储，金额是各桶分子求和后一次性四舍五入，不经过浮点累加。
- 三个计费桶：未缓存输入、缓存读取、输出。`reasoning` 是输出的子集，只展示不重复计费。官方未公布独立的 cache-write 价格，因此该桶只统计、不计费。
- 未知模型**不套默认价**，显示为"未配置价格"，避免用别的模型价格编造金额。
- 价格带版本：当前内置 DeepSeek 公开价快照（2026-09-15，含阶梯时段），每条记录都保存当时采用的价格表 ID，改价不会改写历史。

### 账号类型与企业合同价

账号类型是**用户声明**，不是检测结果：DeepSeek 公开 API 不返回实名类型，官方 FAQ 也说明个人与企业当前在产品功能和权益上无差异，差异主要在认证流程、对公充值与发票抬头。

- 设置页可选 `未声明 / 个人 / 企业（用户声明）`；
- 只有声明为企业、且配置了在有效期内、模型匹配的合同价时，合同价才生效；
- 企业身份本身不会自动产生折扣；没有有效合同价时回退到公开价估算；
- UI 会显示实际采用的是"公开价"还是"合同价"，以及合同表名称与有效期。

### 数据与隐私

- 账本位于 `$DSH_HOME/storages/openai-subscription-meter/usage.json`，只保存调用事实与当时报价，不保存提示词、响应正文或密钥；
- 设置位于 `$DSH_HOME/plugin-state/openai-subscription-meter.json`，带 revision，冲突写入返回 409 而不是覆盖；
- 余额查询每次重新解析 `DEEPSEEK_API_KEY`（或 `llm-deepseek.apiKeyEnv` 指定的变量），只允许发往 HTTPS `api.deepseek.com`，禁止重定向；失败保留上一次成功读数；
- 设置页可分别隐藏余额与费用，token 统计不受影响。

## DSH 工具权限

Provider 会把 DSH 工具 schema 转换为模型可用的 Responses 工具定义。普通参数保持不变，但不会向模型暴露 `sandbox_permissions` 和 `justification`。

这两个字段由 DSH 的审批和权限系统管理，用于对单次工具调用进行严格的权限加宽。它们不是普通业务参数。在会话已经处于 `danger-full-access` 时，继续申请同级权限会被 DSH 以 `not strictly wider` 拒绝，模型可能因此重复提交相同请求。隐藏这些字段后，模型无法进入该重试循环。若命令被受限文件策略拒绝，模型应提示用户切换 DSH 权限预设。

相关实现位于 `src/provider/request-builder.js` 的 `buildResponsesTools`。

## Rescue CLI

Rescue CLI 不依赖插件 Runtime，可在 Web 设置页或 DSH 启动异常时单独运行。

```sh
# 查看脱敏状态
dsh-openai-subscription-rescue status

# 检查依赖和激活条件
dsh-openai-subscription-rescue doctor --profile path/to/profile/package.json

# 创建或回滚快照
dsh-openai-subscription-rescue snapshot
dsh-openai-subscription-rescue rollback

# 启用或禁用插件
dsh-openai-subscription-rescue enable
dsh-openai-subscription-rescue disable
```

所有状态输出都会脱敏。OAuth access token、refresh token 和备份密码不会写入日志或状态响应。

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
npm run test:integration  # 真实 DSH 组合 smoke：装进真实 Cordis 上下文驱动一次 llm/stream，
                          # 验证它变成一条已计价账本记录；缺少 DSH 依赖时安全跳过
```

## 目录结构

```text
src/
  index.js                 Cordis 插件入口
  bootstrap.js             安全引导与失败隔离
  runtime.js               Runtime 装配，包括凭据、OAuth、额度、路由和 adapter
  config.js                配置归一化与激活判断
  state.js                 DSH_HOME 下的 kill switch 状态
  conflicts.js             Provider、namespace 与凭据冲突检查
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
    request-builder.js     Responses 请求构造与工具 schema 转换
    adapter.js             OpenAI 订阅 Provider adapter
    event-translator.js    Responses SSE 到 DSH chunk 与 token 用量的转换
  stream/                  SSE parser
  web/                     本地同源 Web API 路由
client/
  client.js                设置页、首次启动引导、可拖拽的额度指示器
test/                      Node.js 单元测试
cordis.patch.yml           DSH bundle patch 定义
```

## 已知限制

- OAuth、模型目录和额度接口的完整验证需要真实账号及明确授权。
- ChatGPT / Codex 非公开接口可能随时调整协议或返回字段。
- 缓存命中依赖上游在 `usage.input_tokens_details.cached_tokens` 中上报；未上报时不会显示命中率。
- DeepSeek 费用是本地估算：价格来自 2026-09-15 的公开价快照，官方改价后需要更新价格表；跨阶梯时段的请求按**请求开始时刻**取档，官方未公开实际结算规则。
- 账号类型无法自动识别，企业身份始终是用户声明；插件不读取也不展示官方账单、发票或信用额度。
- 只统计本 DSH 进程内的调用；同账号在其他机器或客户端上的消耗不会进入本地账本。
- 高级模型配置 UI 尚未覆盖 Provider 的全部参数。

## 许可证

MIT
