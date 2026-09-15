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
54b7284 2026-09-15 feat: show the GLM plan and packages in the meter
7aa4cff 2026-09-15 feat: keep an account reading behind its lifecycle slot
ff42839 2026-09-15 feat: read the Zhipu account through its own station
172677f 2026-09-15 feat: register the metered vendors in one table
c3f27d9 2026-09-15 feat: keep the meter numbers on desktop and shrink to an icon when narrow
25221a5 2026-09-15 feat: show the sidebar meter as an icon that opens its data on click
907a59a 2026-09-15 feat: reduce the meter settings to the display currency
5367490 2026-09-15 fix: read the account quota on the OpenAI panel whatever the session runs
eedd2c0 2026-09-15 feat: read the DeepSeek balance on demand and expose its switch
```

### 智谱 GLM（本轮）

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
