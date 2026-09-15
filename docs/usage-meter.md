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
| 价格 | 官方价格页快照 | 带版本，改价不改历史 |
| 账号类型 | 用户设置 | 公开 API 不返回实名类型 |

费用永远不是账单。UI 与文案统一使用"估算"。

## Modules

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

### `usage/service.js`

组装计价、账本与余额，产出浏览器视图模型。视图里没有密钥、没有原始事实、没有企业合同内部备注。`hideBalance` 只去掉余额，`hideCost` 只去掉金额，token 始终保留。

### `usage/settings-store.js`

设置放在插件自己的状态目录，带 revision；revision 不匹配返回冲突。这里刻意不使用 DSH settings registry：该 registry 需要 schemastery schema，而本插件声明零依赖，引入依赖会破坏"加载失败也不能阻止 DSH 启动"的既有保证。

## 视图与接口

浏览器通过同源路由读取：

| 路由 | 作用 |
|---|---|
| `GET /meter/usage?sessionId=` | 视图模型（账号、余额、价格来源、会话/今日/本月聚合） |
| `POST /meter/deepseek/refresh` | 强制刷新一次余额 |
| `GET/PATCH /meter/settings` | 读设置 / 带 revision 写设置 |

一个路径只注册一次，方法在路由内分发：DSH 的 exact 路由按路径匹配，同一路径注册两次会互相遮蔽。

## UI

- `sidebar.footer.action`：唯一指示器，按 Provider 切换内容，带 generation 守卫丢弃过期响应；复用拖拽、位置持久化、视口夹取与碰撞避让，停靠时排在已有 footer UI 上方。
- `conversation.composer.dock`：会话用量一行，与侧栏共用同一数据源，避免两处数字不一致。
- `settings.section`：账号类型、显示币种、统计时区、读取 DeepSeek 官方余额（关掉则完全不发该请求）、隐藏余额/隐藏费用。每一项都在面板里可达，改动只提交与当前值不同的键。

侧栏与输入框下方的两个席位分别在 `ui-sidebar` 和 `ui-conversation` 中声明，但它们的包名**不**进 `package.json` 的 `dsh.client.inject`：`inject` 声明的是「本 bundle 执行前必须已 materialize 的包行」，属于加载顺序与预取元数据；bundle 通过模块表 `require` 的包才写在 `dsh.client.external` 里。席位既不是前者也不是后者——它是运行时查表，且失败被 `attempt()` 包住，所以两个字段都不该出现它。

## 测试策略

纯函数与契约优先：计价与阶梯时段、采集器的委托/嵌套/并发/中止、账本的原子写与损坏保留、余额端点门禁与多币种、服务层的企业合同价、隐私与按 Provider 限定的计价（OpenAI 只计 token、不计费）、指示器的金额格式与 Provider 切换、meter 路由的方法分发与冲突。真实余额 e2e 需要显式 Key，否则跳过。

## 与旧插件的关系

不读取、不修改、不删除 `$DSH_HOME/storages/cost-meter/ledger.json`。两个 meter 不应长期同时启用：它们都会计量同一批调用，同时开启会出现两套数字。

## 运维检查

`dsh-openai-subscription-rescue meter` 在不加载插件 Runtime 的前提下只读报告落盘状态：ledger 的 schema 版本与事实条数、首末事实时间、设置文件的 revision 与账号/币种/时区/合同价条数，以及旧 `cost-meter` ledger 是否仍在磁盘上。它只读文件、不查网络、不取凭据，也不打印任何 ledger 条目内容。迁移完成后用它确认「新 ledger 已在记账、旧 ledger 仍在原处」。
