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
25221a5 2026-09-15 feat: show the sidebar meter as an icon that opens its data on click
907a59a 2026-09-15 feat: reduce the meter settings to the display currency
5367490 2026-09-15 fix: read the account quota on the OpenAI panel whatever the session runs
eedd2c0 2026-09-15 feat: read the DeepSeek balance on demand and expose its switch
3fab498 2026-09-15 test: render the connection surfaces and read the balance on open
```

侧栏指示器改成**图标 + 点击展开**：远程/手机宽度下不再有一行文字要挤，图标常驻（内联 SVG 柱状图，无字体依赖），点击在其上方展开数据卡片 —— 卡片按视口夹取、`whiteSpace: normal` 换行，Esc / 再点 / × 都能收起。图标本身仍可拖拽并持久化位置，双击复位。卡片内容与悬停提示共用新的 `indicatorDetails()`（`indicatorTooltip()` 现在只是它 `.join(' · ')`），单一来源所以两者不会矛盾。

已知的偶发失败（**不是**本次改动引入，尚未修）：`test/oauth-callback-server.test.mjs` 在**满载**跑全套时偶尔在 `fetch` 处失败（12/12 单独跑全过；两次出现都发生在同一命令里还跑了 pnpm/`dsh plugin add` 的场合）。`startCallbackServer` 的 `port: 0` 路径确实是两步绑定（先绑 IPv4 拿到临时端口，再在同一端口绑 `::1`），第二步若被别的进程抢到会抛 `callback-port-conflict`；但观测到的失败点在 fetch 而不是 bind，所以尚未定论。下次复现时先抓 undici 的 `code`，再决定是给临时端口路径加一次重试，还是让测试对连接类错误重试。

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
