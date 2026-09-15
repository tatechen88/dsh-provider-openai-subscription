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

厂商注册表：每条记录把厂商 id、它下面的 Provider 代号、价格表 id（没有价格表的厂商留空）和它支持的读数类型放在一起。**注册表决定的是「谁能读到账号读数、谁有价格表」，不是「谁被记账」**：计量范围是一个活查询（见 `runtime.js` 的 `createMeterRoutes`），任何 DSH 已注册的 Provider 都记 token，注册表只负责给它加上余额与费率。模块刻意不 import 任何东西，避免 pricing → types → vendors 的循环。

### `usage/types.js`

`validateUsageFact` / `assertUsageFact` 定义一条调用事实的契约：`callId`、`provider`、`model`、可选 `sessionId`/`purpose`、`startedAt`/`completedAt`，以及四个互斥桶加 reasoning。`cacheReadReported` / `cacheWriteReported` 区分"未上报"与"上报为 0"。

### `usage/pricing.js`

价格以「每百万 token 的货币微元」整数存储。`quoteUsage` 在 BigInt 中求和三个分子后一次性四舍五入，因此金额可复现且不受浮点影响。

阶梯时段用固定 `+08:00` 偏移实现（中国自 1991 年起无夏令时），区间为半开 `[start, end)`。`resolveSchedule` 的优先级是合同价 > 当前官方快照 > 历史快照，且合同价只对企业声明可见。

`bandTransition` 与 `isPeakAt` 读同一个时钟，因此卡片承诺的档位与账单实际取的档永远不会不一致；它额外给出**当前档的结束时刻**，让"把批量任务挪到空闲时段"成为可以执行的提示而非一句口号。

已下线的模型名走 alias 而不是复制一份费率：官方价页写明 `deepseek-v4-flash` 与 `deepseek-v4-flash-vision-exp` 仍可调用、由 DeepSeek-V4.1-Flash 提供服务、并按 Flash 价格计费，因此它们解析到 flash 的费率，报价里用 `billedModel` 说明实际采用的是谁的价。alias 之外的未知模型仍然 unpriced。

### `usage/collector.js`

`createUsageCollector` 返回一个 `llm/stream` 监听器：

- 一定调用 `next()`；
- 透传所有 chunk；
- 用 `AsyncLocalStorage` 标记已计量的流，路由型 Provider 在自身 `pull` 内再次进入瀑布时不会重复计费；
- 消费者提前中断时向下游传播 `return()`；
- 没有 usage 就不写事实。

`providers` 既接受固定名单，也接受 `(id) => boolean` 的**活判定**：主机传的是后者，因此「另一个插件刚注册的 Provider」从第一次调用起就被记账。判定本身抛错时不代表任何计量决定，只当作「不计量」——这个监听器观察的是模型调用，绝不能因为一次判定失败而让调用失败。

### `usage/ledger.js`

`UsageLedger` 保存 append-only 事实与当时报价。`callId` 是幂等键；写入 2 秒防抖、串行、临时文件加 rename 原子落盘；`flush()`/`close()` 等待最新字节。文件无法解析或版本不认识时，先改名保留再抛 `UsageLedgerCorruptError`，绝不当作空账本继续。

账本有 **20,000 条的硬上限**，但上限不是清理策略——直接丢最旧事实会静默改写各时间窗的合计。因此 `compact()`（启动时、以及 `retentionDays` 被调小时）把窗口外的原始事实**折叠**成每天 × 每路由 × 每模型的 rollup 条目：token 各桶与各币种金额都是整数求和，窗口只做加法，所以**每个合计在压实前后一分不差**。rollup 是独立条目类型（schema v2；v1 文件仍可读，下次写入即升级），带自己的标记与校验，不进 call-id 幂等表；`unpricedModels` 不看 rollup——历史缺口不是还能补的缺口。rollup 没有会话，**会话级明细的回溯范围即保留窗口**，这是压实唯一的代价。`mutations` 计数器在每次条目变化时递增，是服务层视图缓存的失效信号。

`summary(range, provider?)` 与 `sessionSummary(sessionId, provider?)` 的第二个参数是**归属**而不是事后过滤：指示器描述的是当前模型，别家的 token 不能加进来。不传则保持全局汇总，供不针对某一路由的读取使用。`unpricedModels(providers?)` 按 `(provider, model)` 汇总未定价调用（次数、最近时间、原因），只有传入了「有价格表的路由」时它才代表真正的缺口。

### `usage/deepseek-balance.js`

`resolveOfficialEndpoint` 只接受 HTTPS 且 host 恰为 `api.deepseek.com`；其他地址一律拒绝，密钥不外发。响应保留每一个 `balance_infos` 行；主行选择顺序为：有余额的 CNY → 有余额的首行 → CNY → 首行。

### `usage/zhipu-account.js`

一个 Provider 代号对应一个站点主机与一条认证方式：中国站（`open.bigmodel.cn`）的用量端点用**原始 Key**，其余端点用 `Bearer`，国际站（`api.z.ai`）走另一条记录。解析器共享一条铁律——**业务性拒绝不是 0**：「当前用户不存在 coding plan」返回 HTTP 200 + `code:500`，解析为 `applicable: false` 加官方措辞；空字符串余额不当作 0。资源包只取 `EFFECTIVE`，且按 `tokenBalance` 判断剩余量；`TOKENS` 计 token、`TIMES` 计次。单轮里只要还有一项读到就返回部分结果，把失败项放进 `errors[]`；一项都没读到则**抛错**，让调用方保留上一次成功读数而不是把快照清空。

### `usage/service.js`

组装计价、账本与两家厂商的账户读数，产出浏览器视图模型。视图里没有密钥、没有原始事实、没有企业合同内部备注。`hideBalance` 只去掉余额，`hideCost` 只去掉金额，token 始终保留；GLM 的现金余额受 `hideBalance` 约束，资源包 token 不受——token 永远不是隐私。`view({sessionId, provider})` 收到厂商提示时才触发那一家的到期刷新，并按该路由收窄三个时间窗；`metered` 切片告诉页面「现在到底在统计哪些 Provider」，客户端不再自带名单。

`view` 的四个账本扫描切片（三个时间窗 + 未定价清单）按 `(generation × ledger.mutations × provider × sessionId)` **缓存**：两个轮询面每 30 秒各读一次，多数轮询之间账本毫无变化，重复扫描纯属浪费。账户切片与读数触发**刻意留在缓存之外**——它们随后台读数变化，账本看不见。`pricing.band` 同理：它取决于墙上时钟，由 `bandTransition` 每次现算。

`publicSchedules()` 的返回顺序是有意的：**学到的表在前、内置快照在后**。`resolveSchedule` 先按状态、再按 `retrievedAt` 排序，所以新表覆盖它带的模型，快照继续为它没有的模型兜底，合同价仍然压过两者。`recordUsage` 在报价为 `unknown-model` 时后台触发一次价格页刷新（开关默认关）；`refreshPublicPrices` 是单飞的，任何解析失败都只记录原因、不动正在生效的表。

### `usage/deepseek-pricing-page.js`

官方价格页被当作数据读：`fetchPricingPage` 只请求 HTTPS 的 `api-docs.deepseek.com`、禁止重定向、超时覆盖响应体，且不携带任何凭据（那是公开文档页）。`parsePricingPage` 把转置表格按 `rowspan`/`colspan` 铺成网格后逐列取费率：模型 slug 取自表头，`空闲时段`/`高峰时段` 两档、缓存命中/未命中/输出三类必须**齐全**，金额按十进制字符串转成整数微元（不经浮点）。高峰时段从页面脚注读，读不到才回退内置 `PEAK_WINDOWS` 并把 `windowSource` 标成 `builtin`。旧模型别名只在**页面仍然提到它、且它指向的模型仍在页面上**时保留——厂商下线的名字因此不会再被计价。任何一行读不出来就整表拒绝，返回 `{ok:false, reason}`。

### `usage/pricing-store.js`

学到的价格表存在 `storages/openai-subscription-meter/prices.json`：临时文件 + rename 原子写、写入串行。它是**派生数据**，因此读不出来时只报告原因然后当作不存在，内置快照继续计价；文件同时记住最后一次尝试的时刻与失败原因，好让「页面停止解析」这件事在卡片和 `rescue meter` 里看得见。刷新间隔 24 小时，失败同样按尝试时刻退避。

### `usage/settings-store.js`

设置放在插件自己的状态目录，带 revision；revision 不匹配返回冲突。这里刻意不使用 DSH settings registry：该 registry 需要 schemastery schema，而本插件声明零依赖，引入依赖会破坏"加载失败也不能阻止 DSH 启动"的既有保证。

### `usage/reading-slot.js`

账户读数的**生命周期**被抽成一个类，两家厂商共用：TTL 缓存、单飞（同一时刻只有一个在途请求）、按「上次尝试时刻」判断是否到期（失败也会退避，不会每个请求都重试）、世代守卫丢弃过期响应、失败时保留上一次成功读数，以及一个把读数整体关掉的开关。视图只读它暴露的 `reading`，因此「过期但可用」与「不可用」在 UI 上是两种状态（`ok` / `stale`）。

## 视图与接口

浏览器通过同源路由读取：

| 路由 | 作用 |
|---|---|
| `GET /meter/usage?sessionId=&provider=` | 视图模型（账号、余额、GLM 读数、价格来源、未定价模型、会话/今日/本月聚合） |
| `POST /meter/deepseek/refresh` | 强制刷新一次 DeepSeek 余额 |
| `POST /meter/zhipu/refresh` | 强制刷新一次 GLM 账号读数 |
| `POST /meter/prices/refresh` | 强制读一次官方价格页（与开关无关，供排障用） |
| `GET/PATCH /meter/settings` | 读设置 / 带 revision 写设置 |

`provider` 是**提示而不是过滤**：视图永远返回完整模型，只有该厂商的读数到期时才会去问那个站点，因此切到别的 Provider 不会顺带查一个无关账号；同时它又是**归属**，三个时间窗按它收窄。三条 refresh 路由目前只有测试在驱动，客户端靠轮询、TTL 与开关自己刷新。

一个路径只注册一次，方法在路由内分发：DSH 的 exact 路由按路径匹配，同一路径注册两次会互相遮蔽。

## UI

- `sidebar.footer.action`：唯一指示器，按视口宽度切换两种渲染 —— **≥ 640px 直接显示文字摘要**（余额/配额 + 今日消费），**< 640px 收成一个内联 SVG 图标**，点击后在图标上方展开数据卡片并在视口内夹取、换行（Esc、再点、× 都能收起）。两种渲染共用 `indicatorDetails()`，卡片与悬停提示不会互相矛盾。带 generation 守卫丢弃过期响应；图标/文字块可拖拽并持久化位置，双击复位。窗口 resize 时即时切换，无需刷新。
- **浮动的两个元素都挂在 `document.body` 上**（`react-dom` 的 portal）：席位在侧边栏里，而侧边栏裁剪自己的子树 —— rail 收起/展开期间带动画的祖先同时是包含块，此时 `overflow: hidden` 连 `position: fixed` 的后代一起裁掉，卡片会被切在侧边栏右边缘。模块表没有 `react-dom`（或没有 `document`）时两者退回原地渲染，功能不变但会重新受祖先裁剪。层级取 120：压过应用 chrome（最高 100），仍在模态层（1000）之下。
- **卡片会自动收回**：打开后 12 秒倒计时，卡片上的指针交互重新计时；点卡片外（`document` 捕获阶段的 `pointerdown`，被下游 `stopPropagation` 吞掉的按压也算）、再点图标、Esc、以及**切换模型**都立即收回。切换模型这一条是必须的：卡片描述的是上一个账号，留着它就等于显示过期数字。
- `conversation.composer.dock`：会话用量一行，与侧栏共用同一数据源，避免两处数字不一致。
- `settings.section`：用量与费用面板只保留**显示币种**（CNY / USD）与保存按钮；账号类型、统计时区、是否读取 DeepSeek 官方余额、是否自动纳入所有已注册 Provider、是否读官方价格页、隐藏余额/隐藏费用都退回 `cordis.patch.yml` 的 `meter` 配置层，面板不再暴露。改动只提交与当前值不同的键。

卡片还承担两件「看得见」的职责：**未定价模型**（`未配置价格: deepseek-v5 ×3`，按卡片描述的 Provider 过滤）与**价格表刷新失败的原因**。没有这两行，"新模型停在未定价" 和 "页面改版导致自动更新静默失效" 都无从察觉。

侧栏与输入框下方的两个席位分别在 `ui-sidebar` 和 `ui-conversation` 中声明，但它们的包名**不**进 `package.json` 的 `dsh.client.inject`：`inject` 声明的是「本 bundle 执行前必须已 materialize 的包行」，属于加载顺序与预取元数据；bundle 通过模块表 `require` 的包才写在 `dsh.client.external` 里。席位既不是前者也不是后者——它是运行时查表，且失败被 `attempt()` 包住，所以两个字段都不该出现它。

## 测试策略

纯函数与契约优先：计价与阶梯时段、采集器的委托/嵌套/并发/中止与活判定门禁、账本的原子写/损坏保留/按路由归属与未定价汇总、余额端点门禁与多币种、服务层的企业合同价、隐私与按 Provider 限定的计价（OpenAI 只计 token、不计费）、指示器的金额格式与 Provider 切换、meter 路由的方法分发与冲突。

三条口径各有专门的覆盖：**模型自动发现**（`createMeterRoutes` 的注册名单、5 秒过期、auto 关掉后回退注册表、context 没有 llm 时不致命，外加集成冒烟里注册一个本插件从未听说过的 adapter 并断言事实落账）；**按路由归属**（三厂商混合账本下各 Provider 的时间窗互不串台，无 provider 提示时保持全局）；**价格页**（真实页面夹具逐项对齐内置快照、时段句与别名、缺行/非人民币/整表颠倒一律拒绝、`yuanToMicros` 的精度边界、store 的原子写与损坏回退、learned 覆盖与快照兜底的优先级、开关关闭时不发请求、失败退避）。

真实余额 e2e 需要显式 Key，否则跳过；价格页解析另有一次性的人工验证（对线上页面跑 `fetchPricingPage` + `parsePricingPage`），因为夹具会随时间与线上漂移。

## 与旧插件的关系

不读取、不修改、不删除 `$DSH_HOME/storages/cost-meter/ledger.json`。两个 meter 不应长期同时启用：它们都会计量同一批调用，同时开启会出现两套数字。

## 运维检查

`dsh-openai-subscription-rescue meter` 在不加载插件 Runtime 的前提下只读报告落盘状态：ledger 的 schema 版本与事实条数、首末事实时间、**未定价模型清单**（只列出有价格表的路由，按调用次数排序，只给模型名不给调用与会话）、设置文件的 revision 与账号/币种/时区/合同价条数，以及旧 `cost-meter` ledger 是否仍在磁盘上。它只读文件、不查网络、不取凭据，也不打印任何 ledger 条目内容。迁移完成后用它确认「新 ledger 已在记账、旧 ledger 仍在原处」；新模型发布后用它确认「内置快照还没有这个费率」。
