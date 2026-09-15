# HANDOFF

> 交接说明：给接手本仓库的下一个 agent 或新 session。最后更新 2026-09-15。

## 这是什么

面向 DeepSeek Harness（DSH）的独立 OpenAI / ChatGPT 订阅 Provider。使用 ChatGPT OAuth 凭据访问 Codex Responses 接口，向 DSH 提供模型目录、流式生成、token 用量（含缓存命中）、订阅额度查询与 Web 设置界面；额度指示器默认停在侧边栏底部，可拖动。

设计前提（`package.json` 明写）：**安全引导——插件失败绝不能阻止 DSH 启动。**

## 快速上手

| 事项 | 做法 |
|---|---|
| 测试 | `npm run test`（本仓 verify 命令，见 `AGENTS.md` 的 `## Agent skills`） |
| 接入 DSH | `cordis.patch.yml`——本插件在 profile 层栈中的插入点 |
| issues / specs | `docs/agents/issue-tracker.md`——本地 markdown tracker，放在 `.scratch/<feature>/` |

## 最近在做什么

```
<docs> 2026-09-15 docs: record the hardening and optimization round
c02e1c3 2026-09-15 feat: show the price band, reasoning tokens, and per-model session breakdown
c35cf06 2026-09-15 perf: cache the meter's ledger scans between polls
748b8ae 2026-09-15 feat: fold old ledger facts into day rollups instead of dropping them
bafae8a 2026-09-15 fix: harden the client reads, the price refresh route, and the syntax check
449e096 2026-09-15 feat: expire the model catalog cache
7a61c4b 2026-09-15 feat: refresh the price table from the vendor page
2d6b650 2026-09-15 feat: name the models the price table does not cover
0787507 2026-09-15 feat: meter every registered route without a registry entry
8bdb623 2026-09-15 fix: scope the meter totals to the route they describe
0d4d6cd 2026-09-15 test: add the official DeepSeek pricing page fixture
cc73b0f 2026-09-15 fix: float the meter card and panel above the sidebar and retract them
45fe074 2026-09-15 docs: hand off the GLM meter round
54b7284 2026-09-15 feat: show the GLM plan and packages in the meter
7aa4cff 2026-09-15 feat: read the Zhipu account through the meter's reading slot
ff42839 2026-09-15 feat: read the Zhipu account from its official station
172677f 2026-09-15 refactor: keep the metered vendors in one registry
9025543 2026-09-15 docs: record the responsive indicator in the handoff
c3f27d9 2026-09-15 feat: keep the meter numbers on desktop and shrink to an icon when narrow
7393db7 2026-09-15 docs: record the icon indicator and the known flake in the handoff
25221a5 2026-09-15 feat: show the sidebar meter as an icon that opens its data on click
69247df 2026-09-15 docs: record the meter panel reduction in the handoff
907a59a 2026-09-15 feat: reduce the meter settings to the display currency
6213f43 2026-09-15 docs: record the OpenAI panel balance fix in the handoff
```

### 新模型自动出现（本轮）

用户的原话是「模型经常变换，每次有新的模型出现时，这个项目也要能自动检测出来并加上」。今天一个模型/Provider 从未见过的样子有三种，分别处理：

1. **Provider 没注册过**（`0787507`）。`vendors.js` 的职责收窄成「谁能读到账号读数、谁有价格表」，**不再决定谁被记账**：`runtime.js` 的 `createMeterRoutes(ctx)` 把 `METERED_PROVIDERS` 和 `ctx.llm.listProviders()` 合起来，5 秒记忆化，collector 的门禁从冻结名单换成这个活判定；`view().metered` 把同一个清单交给页面，客户端不再自带名单（旧宿主没有该字段时回退到内置三家）。判定抛错只当作「不计量」——这个监听器观察模型调用，绝不能因为一次判定失败让调用失败。**边界**：自动覆盖只给 token，账号读数与价格表仍要显式登记，所以新厂商的「还剩多少」不会凭空出现。
2. **数字串台**（`8bdb623`，顺序上先修）。此前 `ledger.summary(range)` 不按 Provider 过滤，三家的 token 混在同一个「今日/本月」里；不先修，自动纳入越多越糊。现在 `summary(range, provider?)` / `sessionSummary(sessionId, provider?)` 的第二个参数是**归属**，`view` 带提示时按它收窄，不传保持全局。
3. **新模型没费率**（`2d6b650` + `7a61c4b`）。先点名：`ledger.unpricedModels(providers)` 按 `(provider, model)` 汇总未定价调用，`view().pricing.unpricedModels` 交给卡片（`未配置价格: deepseek-v5 ×3`），`rescue meter` 报同一段。再（可选、默认关）让表自己去官方页更新。

价格页那一步值得单独记：`resolveSchedule` 找不到费率时返回 undefined，所以 `recordUsage` 原先把「表里没这个模型」和「这个厂商根本没有表」都记成 `no-schedule`。现在它按搜过的 `schedules` 里有没有该 provider 来区分——新模型因此记成 `unknown-model`，这也成了触发刷新（和 `unpricedModels` 过滤）的信号。学到的表排在快照之前，`byPrecedence` 用 `retrievedAt` 让它在自己覆盖的模型上胜出、缺的模型回退快照，合同价仍压过两者——**解析器一行没改**。

三条铁律写进了代码与注释：**整表解析成功才采用**（缺行/非人民币/两档颠倒一律整表拒绝，旧表继续生效，原因记进 `prices.json` 并显示在卡片上）；**绝不编价**（页面没写的费率不推算，也不拿别的模型顶替）；**改表不改历史**（每条事实存当时的价格表 ID）。旧模型别名只在页面仍提到它、且目标模型仍在页面上时保留。

实测（阶段 0 与收尾各一次）：线上价格页 21493 字节，只有一张转置表；模型 slug 与内置快照的键完全一致；脚注 (3) 自述高峰时段「周一至周五 9:00-12:00、14:00-18:00」与内置 `PEAK_WINDOWS` 一字不差，脚注 (1) 给出两个旧模型名及其按 Flash 计价的归属；`fetchPricingPage` + `parsePricingPage` 对线上页面端到端跑通，产出与快照逐项相同。夹具 `test/fixtures/deepseek-pricing-page.html` 是同一页面裁到「表 + 脚注」（服务端页面里有一个 NUL 字节，已在夹具头注明被剥掉）。

`449e096` 顺带修了另一个「新模型不出现」的老问题：adapter 的目录缓存是**进程级永久**的，`/models/refresh` 也只是返回缓存。现在 TTL 10 分钟，并新增 `invalidateCatalog()`，路由先清缓存再列。

本轮已发版 **1.3.0**（`chore: release 1.3.0` + 附注标签 `v1.3.0`，含 GitHub Release）。

### 严格体检与四段优化（本轮）

一轮全面审计后按批准的四段路线执行，导出与预算两项被用户明确划掉。发现与修法：

1. **账本压实替代裸截断**（`748b8ae`，最大单项）。审计发现账本有 20,000 条 FIFO 上限（此前无人注意），直接丢最旧事实会静默改写各时间窗合计，且每次写入都是全文件重写——封顶后写放大约 7GB/天。现在 `compact()` 把 `retentionDays`（默认 90，0=永不）窗口外的原始事实折叠成**每天 × 每路由 × 每模型**的 rollup：token 桶与各币种金额整数求和，窗口只做加法，锚点测试断言压实前后 `summary('all'/'today'/scoped)` **逐项相等**。rollup 是独立条目类型（`rollup: true`，schema v2，v1 文件仍可读、下次写入升级），有自己的校验 `isReadableRollup`，不进 call-id 幂等表；`unpricedModels` 不看 rollup（历史缺口不是还能补的缺口）；rollup 无会话，**会话明细的回溯范围即保留窗口**——这是压实唯一的代价，README 已写明。踩过的坑：`summary` 内层过滤、cap 淘汰循环、`#mergeFromDisk` 的 `known` 集合原来都直接读 `entry.fact.*`，rollup 一进列表就会崩——全部收敛到模块级访问器（`entryStartedAt/entryProvider/entryModel/entryCalls/entryUsageOf/entryAmounts`）。
2. **视图扫描缓存**（`c35cf06`）。两个轮询面每 30s 各读一次，每次 4 个全量扫描；现在三个时间窗切片按 `(generation × ledger.mutations × provider × sessionId)` 缓存，未定价清单按 `(generation × mutations)` 缓存。**账户切片与读数触发刻意留在缓存外**——它们随后台读数变化，账本看不见。
3. **功能三件**（`c02e1c3`）：`pricing.band = bandTransition(now, windows)`（与 `isPeakAt` 同读一个时钟，测试用一周半小时步进扫描断言两者永不打架），卡片显示「高峰时段 · 42 分钟后转空闲时段（半价）」；tokenLines 标注 reasoning 子集（`（含思考 12.0K）`，数据本就在聚合里，只是从没显示）；`viewOfAggregate` 把内部 `byModel` 暴露成 top-3 会话构成。
4. **加固**（`bafae8a`）：客户端 `getJson` 加 45s 超时（必须大于服务端模型目录的 30s 上限，防悬挂连接堆积轮询）；`/meter/prices/refresh` 的 force 路径加 60s 冷却（同源脚本不能再借 force 高频打官方页）；`check` 脚本从 40+ 项手工清单改为 `scripts/check-syntax.mjs` 目录遍历——本轮审计自己也踩了一次"新文件忘加清单"的坑。

另：测试骨架的三份相同 `createHookRuntime` 收敛到 `test/helpers.mjs`（故意不叫 `*.test.mjs`，跑测 glob 不会执行它）；各文件的 `fact()` 语义各不相同，是夹具不是重复，保留。

### 浮动与自动收回（上一轮）

远程手机上的截图暴露了一个此前没有被验证过的问题：**卡片虽然写了 `position: fixed`，却被切在侧边栏右边缘**。原因是 `position: fixed` 只有在祖先不是它的包含块时才逃得掉 `overflow: hidden`；侧边栏的 rail 收起/展开带 `transform` 动画，动画期间那个祖先就是包含块，于是卡片被裁。之前桌面拖拽"能用"只说明数字位置算对了，没人从手机上看过。

修法是让浮动的两个元素**离开那棵子树**：`react-dom` 的 `createPortal(element, document.body)`。拖动后的浮动面板（`floating === true` 时的按钮本身）和详情卡片都走 portal；模块表里没有 `react-dom`、或没有 `document` 时（测试与老客户端宿主）两者退回原地渲染，功能不变但会重新受祖先裁剪。层级从 40/41 提到 120：压过应用 chrome（最高 100），仍在模态层（1000）之下。

顺手按用户要求加了**自动收回**：卡片打开后 12 秒倒计时（`AUTO_COLLAPSE_MS`），卡片上的指针交互会重新计时；点击卡片外（`document` 捕获阶段的 `pointerdown`，被下游 `stopPropagation` 吞掉的按压也算）、再点图标、Esc、以及切换模型都立即收回。切换模型这条是必须的：卡片描述的是上一个账号。

测试在 `test/client-float-portal.test.mjs`（4 条，本仓唯一带 `document` 与 `react-dom` stub 的 harness）：拖动后按钮挂到 body、卡片挂到 body 且不裁剪、倒计时与外部按压的收回、切换模型收回。`client-ui.test.mjs` 继续覆盖"没有 `react-dom` 时原地渲染"的降级路径——两个 harness 的模块表不同，正因为行为本来就不同。踩过的坑：那份 harness 里 `hooks` 是模块级变量，`mount()` 必须重置它，否则第二个测试会拿到第一个测试的状态槽；以及 `useCurrentProvider` 是**订阅驱动**的（不随每次渲染重读），测试里换 Provider 必须触发 `sessionsService.list.subscribe` 的回调。

### 智谱 GLM

指示器多跟一家厂商：**智谱 GLM**（pi-ai 的 `zai-coding-cn` 路由，模型如 `glm-5.3`）。四段实现各自独立提交，任何一段都可以单独回退：

1. **`usage/vendors.js`——厂商注册表。** 厂商 id、Provider 代号、价格表 id（GLM 留空）、支持的读数类型集中在一处，`METERED_PROVIDERS` 由它派生。模块不 import 任何东西，因为价格解析要 import 它，反过来会成环。
2. **`usage/zhipu-account.js`——账号读数。** 主机与认证方式按 Provider 代号选：中国站 `open.bigmodel.cn` 的用量端点用**原始 Key**，其余端点用 `Bearer`；国际站 `api.z.ai` 是另一条记录，目前没有客户端入口。
3. **`usage/reading-slot.js` + 接线。** TTL、单飞、按上次**尝试**时刻计时（失败也退避）、世代守卫、失败保留上次成功读数——两家厂商共用。`view({sessionId, provider})` 收到厂商提示才触发那一家的到期刷新，所以切到别的 Provider 不会白查一个账号。
4. **客户端与文档。** 桌面一行 `GLM 余 14M · 今日 1.2M`，卡片列出 Coding Plan 窗口、现金余额、每个资源包（名称、剩余、模型范围、到期日）。`meterUsageUrl()` 把 `provider` 提示带进读请求，`sessionUsageLine` 的标签在 GLM 会话里是 `GLM`。

三条口径值得记住：**业务性拒绝不是 0**（「当前用户不存在 coding plan」是 HTTP 200 + `code:500`，卡片照抄官方措辞）；**空字符串余额不是 0**；**GLM 只计量不计价**（订阅制没有按 token 价格，台账里永远是 `unpriced` / `no-schedule`，DeepSeek 的价格表绝不给它计价——有测试守着）。全量失败时加载器**抛错**而不是返回空快照，否则会把上一次成功读数抹掉。

本机实测（该部署的账号）：两个站点都答「无 coding plan」，现金 `availableBalance=0`、`totalSpendAmount=0`，5 个 `EFFECTIVE` 资源包（2M 通用、6M glm-4.6v、12M glm-4.5-air、20 次图片/视频、100 次搜索，均 2026-11-27 到期），`tokenBalance === tokensMagnitude`（未消耗）。凭据在 `.credentials.yaml` 的 `ZAI_CODING_CN_API_KEY`，**不在进程环境**，所以必须走 `ctx.credentials`；解析顺序是设置里的 `llm-pi-ai.providers['zai-coding-cn'].apiKeyEnv` → `ZAI_CODING_CN_API_KEY` → 进程环境。

仍未接的两处（都留着测试驱动，不是忘记）：`POST /meter/deepseek/refresh` 与 `POST /meter/zhipu/refresh` 没有客户端调用者，界面靠轮询 + TTL 自刷新；国际站 `zai` 路由需要自己的凭据引用还没有条目。

侧栏指示器**按视口宽度自适应**（阈值 `NARROW_VIEWPORT_PX = 640`）：

- **桌面宽度（≥ 640px）直接显示文字摘要** —— DeepSeek 是 `DeepSeek ¥余额 · 今日 ¥消费`，OpenAI 是各额度窗口剩余百分比，GLM 是 `GLM 余 14M · 今日 1.2M`（资源包剩余 token + 今日用量）。使用者不用点就能看到花掉多少、还剩多少。
- **手机宽度 / 远程接入（< 640px）收成一个内联 SVG 图标**（无字体依赖），点击在图标上方展开数据卡片；卡片按视口夹取、`whiteSpace: normal` 换行，Esc / 再点 / × 都能收起。
- 窗口 resize 即时切换，无需刷新；两种渲染都可拖拽并持久化位置，双击复位，拖拽后的一次点击不会误触发卡片（靠 `dragRef.moved` 判定）。
- 卡片与悬停提示共用 `indicatorDetails()`（`indicatorTooltip()` 现在只是它的 `.join(' · ')`），单一来源所以两者不会矛盾。

已知的偶发失败（**不是**这些改动引入，尚未修）：`test/oauth-callback-server.test.mjs` 在**满载**跑全套时偶尔在 `fetch` 处失败（12/12 单独跑全过；出现过两次，都在同一命令里还跑了 pnpm/`dsh plugin add` 的场合）。`startCallbackServer` 的 `port: 0` 路径确实是两步绑定（先绑 IPv4 拿到临时端口，再在同一端口绑 `::1`），第二步若被别的进程抢到会抛 `callback-port-conflict`；但观测到的失败点在 fetch 而不是 bind，所以尚未定论。下次复现时先抓 undici 的 `code`，再决定是给临时端口路径加一次重试，还是让测试对连接类错误重试。

产品口径：**「用量与费用」面板只保留显示币种（CNY / USD）与保存按钮**。账号类型、统计时区、是否读取官方余额、隐藏余额/隐藏费用、企业合同价都退回 `cordis.patch.yml` 的 `meter` 配置层（能力全部保留，只是不再由面板暴露）；面板不再有「刷新余额」按钮，因为余额现在由服务端按需自动读取。字典里随之删掉了 8 个只剩定义、没有任何调用点的键 —— 注意工具提示仍在使用 `meterAccountHint` / `meterAccountUnknown` / `meterAccountPersonal` / `meterAccountEnterprise`，改字典前务必 grep 具体键名而不是只 grep `t('meter…')` 字面量。

近期主线是计量正确性：并发 ledger 写入合并（重读＋按 callId 合并，写前 fsync）、审计发现的 metering / settings 缺陷修复、provider 级定价的测试覆盖、连接链路的页面级渲染测试（`test/client-page-render.test.mjs`），以及余额读取链路。

三个「只有真跑起来才会发现」的缺陷，都已修复并有回归测试：

1. 登录后的设置页从不做首次余额读取，只起了 5 分钟轮询（打开即读已修）。
2. 侧栏只显示「今日消费」不显示余额：`balanceView()` 只读缓存，而余额唯一的触发点是设置页那个刷新按钮，进程重启后 `status` 一直停在 `idle`，于是指示器里没有 `primary` 可显示。现在 `view()` 发现读数缺失/过期会**不等待地触发一次读取**（`balanceDue()` 按上次尝试计时，失败不会按每次轮询重试），插件启动时也会预热一次；`meter.deepseekBalance` 同时作为设置页里可达的开关 —— 关掉即完全不发该请求，状态报 `off`。
3. 设置页里的 Balance 永远「暂无数据」：`useOpenAISubscriptionFlow` 的 `provider` 传的是**当前会话的** Provider，而 `refreshBalance()` 在 `provider !== 'openai-subscription'` 时直接返回并把余额清空 —— 于是在 DeepSeek 会话里打开 OpenAI 面板，配额块永远空白、刷新按钮也点不动。该页面是 OpenAI 账号自己的面板，现已固定用 `PROVIDER_ID`；侧栏仍跟随当前模型（那是它的职责）。

拆除顺序也顺带修了：`applyRuntime` 的 disposer 现在逐项 try/catch 且按序 await，最后的 ledger flush 不会因为前面某个 surface 抛错而被跳过，调用方 await 它就能等到落盘完成。

## 关键文件

- `src/`——Provider 主体（模型目录、流式生成、用量与额度）
- `client/`——Web 设置界面与侧边栏额度指示器
- `test/`——测试
- `cordis.patch.yml`——DSH profile 接入配置
- `README.md`——面向使用者的说明；`AGENTS.md`——仓库约定与 verify 门禁

## 接手时先读

1. `README.md`
2. `AGENTS.md`（`## Agent skills` 的 verify 命令）
3. `docs/agents/issue-tracker.md` 与 `docs/agents/domain.md`
