# 内置用量与费用模块设计

本文件记录实现契约与取舍，供维护者阅读；用户向说明在 README 的「用量与费用」一节。

## 为什么内置

旧部署依赖独立的 `dsh-cost-meter` 提供会话费用。该插件承担了多厂商价格、Coding Plan 额度、预算、热图、峰谷提醒等大量功能，对本仓库的目标过重：本插件只需要在 OpenAI 订阅与 DeepSeek 之间跟随切换，并给出可解释的 token 与费用估算。把这一小块做进插件本身，可以让部署少一个插件、少一份凭据面、少一套账本格式。

## 权威事实

| 事实 | 来源 | 说明 |
|---|---|---|
| 调用 token | DSH `llm/stream` 最终 `usage` chunk | Provider 上报，未上报时不估算 |
| 调用归属 | `GenerateOptions.provider/model/sessionId/purpose` | 用于路由、归集与价格匹配 |
| 账户余额 | `GET https://api.deepseek.com/user/balance` | 只有余额，没有账单 |
| GLM 用量与资源包 | 智谱账号接口，见 `usage/zhipu-account.js` | Coding Plan 窗口额度、现金余额、按包剩余量 |
| 价格 | 官方价格页快照 | 带版本，改价不改历史 |
| 账号类型 | 用户设置 | 公开 API 不返回实名类型 |

费用永远不是账单。UI 与文案统一使用"估算"。

## Modules

### `usage/vendors.js`

厂商注册表：每条记录把厂商 id、它下面的 Provider 代号、价格表 id（没有价格表的厂商留空）和它支持的读数类型放在一起。计量范围（`METERED_PROVIDERS`）由它派生，因此「新增一个要计量的厂商」只有一处改动；价格解析按 `provider` 过滤，任何厂商的价格表都不会给另一个厂商的调用计价。模块刻意不 import 任何东西，避免 pricing → types → vendors 的循环。

### `usage/types.js`

`validateUsageFact` / `assertUsageFact` 定义一条调用事实的契约：`callId`、`provider`、`model`、可选 `sessionId`/`purpose`、`startedAt`/`completedAt`，以及四个互斥桶加 reasoning。`cacheReadReported` / `cacheWriteReported` 区分"未上报"与"上报为 0"。

### `usage/pricing.js`

价格以「每百万 token 的货币微元」整数存储。`quoteUsage` 在 BigInt 中求和三个分子后一次性四舍五入，因此金额可复现且不受浮点影响。

阶梯时段用固定 `+08:00` 偏移实现（中国自 1991 年起无夏令时），区间为半开 `[start, end)`。`resolveSchedule` 的优先级是合同价 > 当前官方快照 > 历史快照，且合同价只对企业声明可见。

已下线的模型名走 alias 而不是复制一份费率：官方价页写明 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 仍可调用、由 DeepSeek-V4.1-Flash 提供服务、并按 Flash 价格计费，因此它们解析到 flash 的费率，报价里用 `billedModel` 说明实际采用的是谁的价。alias 之外的未知模型仍然 unpriced。

### `usage/collector.js`

`createUsageCollector` 返回一个 `llm/stream` 监听器：

- 一定调用 `next()`；
- 透传所有 chunk；
- 用 `AsyncLocalStorage` 标记已计量的流，路由型 Provider 在自身 `pull` 内再次进入瀑布时不会重复计费；
- 消费者提前中断时向下游传播 `return()`；
- 没有 usage 就不写事实。

### `usage/ledger.js`

`UsageLedger` 保存 append-only 事实与当时报价。`callId` 是幂等键；写入 2 秒防抖、串行、临时文件加 rename 原子落盘；`flush()`/`close()` 等待最新字节。文件无法解析或版本不认识时，先改名保留再抛 `UsageLedgerCorruptError`，绝不当作空账本继续。

### `usage/deepseek-balance.js`

`resolveOfficialEndpoint` 只接受 HTTPS 且 host 恰为 `api.deepseek.com`；其他地址一律拒绝，密钥不外发。响应保留每一个 `balance_infos` 行；主行选择顺序为：有余额的 CNY → 有余额的首行 → CNY → 首行。

### `usage/zhipu-account.js`

一个 Provider 代号对应一个站点主机与一条认证方式：中国站（`open.bigmodel.cn`）的用量端点用**原始 Key**，其余端点用 `Bearer`，国际站（`api.z.ai`）走另一条记录。解析器共享一条铁律——**业务性拒绝不是 0**：「当前用户不存在 coding plan」返回 HTTP 200 + `code:500`，解析为 `applicable: false` 加官方措辞；空字符串余额不当作 0。资源包只取 `EFFECTIVE`，且按 `tokenBalance` 判断剩余量；`TOKENS` 计 token、`TIMES` 计次。单轮里只要还有一项读到就返回部分结果，把失败项放进 `errors[]`；一项都没读到则**抛错**，让调用方保留上一次成功读数而不是把快照清空。

### `usage/service.js`

组装计价、账本与两家厂商的账户读数，产出浏览器视图模型。视图里没有密钥、没有原始事实、没有企业合同内部备注。`hideBalance` 只去掉余额，`hideCost` 只去掉金额，token 始终保留；GLM 的现金余额受 `hideBalance` 约束，资源包 token 不受——token 永远不是隐私。`view({sessionId, provider})` 收到厂商提示时才触发那一家的到期刷新。

### `usage/settings-store.js`

设置放在插件自己的状态目录，带 revision；revision 不匹配返回冲突。这里刻意不使用 DSH settings registry：该 registry 需要 schemastery schema，而本插件声明零依赖，引入依赖会破坏"加载失败也不能阻止 DSH 启动"的既有保证。

### `usage/reading-slot.js`

账户读数的**生命周期**被抽成一个类，两家厂商共用：TTL 缓存、单飞（同一时刻只有一个在途请求）、按「上次尝试时刻」判断是否到期（失败也会退避，不会每个请求都重试）、世代守卫丢弃过期响应、失败时保留上一次成功读数，以及一个把读数整体关掉的开关。视图只读它暴露的 `reading`，因此「过期但可用」与「不可用」在 UI 上是两种状态（`ok` / `stale`）。

## 视图与接口

浏览器通过同源路由读取：

| 路由 | 作用 |
|---|---|
| `GET /meter/usage?sessionId=&provider=` | 视图模型（账号、余额、GLM 读数、价格来源、会话/今日/本月聚合） |
| `POST /meter/deepseek/refresh` | 强制刷新一次 DeepSeek 余额 |
| `POST /meter/zhipu/refresh` | 强制刷新一次 GLM 账号读数 |
| `GET/PATCH /meter/settings` | 读设置 / 带 revision 写设置 |

`provider` 是**提示而不是过滤**：视图永远返回完整模型，只有该厂商的读数到期时才会去问那个站点，因此切到别的 Provider 不会顺带查一个无关账号。两条 refresh 路由目前只有测试在驱动，客户端靠轮询与 TTL 自己刷新。

一个路径只注册一次，方法在路由内分发：DSH 的 exact 路由按路径匹配，同一路径注册两次会互相遮蔽。

## UI

- `sidebar.footer.action`：唯一指示器，按视口宽度切换两种渲染 —— **≥ 640px 直接显示文字摘要**（余额/配额 + 今日消费），**< 640px 收成一个内联 SVG 图标**，点击后在图标上方展开数据卡片并在视口内夹取、换行（Esc、再点、× 都能收起）。两种渲染共用 `indicatorDetails()`，卡片与悬停提示不会互相矛盾。带 generation 守卫丢弃过期响应；图标/文字块可拖拽并持久化位置，双击复位。窗口 resize 时即时切换，无需刷新。
- `conversation.composer.dock`：会话用量一行，与侧栏共用同一数据源，避免两处数字不一致。
- `settings.section`：用量与费用面板只保留**显示币种**（CNY / USD）与保存按钮；账号类型、统计时区、是否读取 DeepSeek 官方余额、隐藏余额/隐藏费用都退回 `cordis.patch.yml` 的 `meter` 配置层，面板不再暴露。改动只提交与当前值不同的键。

侧栏与输入框下方的两个席位分别在 `ui-sidebar` 和 `ui-conversation` 中声明，但它们的包名**不**进 `package.json` 的 `dsh.client.inject`：`inject` 声明的是「本 bundle 执行前必须已 materialize 的包行」，属于加载顺序与预取元数据；bundle 通过模块表 `require` 的包才写在 `dsh.client.external` 里。席位既不是前者也不是后者——它是运行时查表，且失败被 `attempt()` 包住，所以两个字段都不该出现它。

## 测试策略

纯函数与契约优先：计价与阶梯时段、采集器的委托/嵌套/并发/中止、账本的原子写与损坏保留、余额端点门禁与多币种、服务层的企业合同价、隐私与按 Provider 限定的计价（OpenAI 只计 token、不计费）、指示器的金额格式与 Provider 切换、meter 路由的方法分发与冲突。智谱一侧用**真实响应夹具**覆盖：业务性拒绝、空字符串余额、非 `EFFECTIVE` 包、`TOKENS`/`TIMES` 两种包、部分失败与全量失败的差别，以及「DeepSeek 的价格表绝不给 GLM 计价」。真实余额 e2e 需要显式 Key，否则跳过。

## 与旧插件的关系

不读取、不修改、不删除 `$DSH_HOME/storages/cost-meter/ledger.json`。两个 meter 不应长期同时启用：它们都会计量同一批调用，同时开启会出现两套数字。

## 运维检查

`dsh-openai-subscription-rescue meter` 在不加载插件 Runtime 的前提下只读报告落盘状态：ledger 的 schema 版本与事实条数、首末事实时间、设置文件的 revision 与账号/币种/时区/合同价条数，以及旧 `cost-meter` ledger 是否仍在磁盘上。它只读文件、不查网络、不取凭据，也不打印任何 ledger 条目内容。迁移完成后用它确认「新 ledger 已在记账、旧 ledger 仍在原处」。
