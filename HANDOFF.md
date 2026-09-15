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
3fab498 2026-09-15 test: render the connection surfaces and read the balance on open
dd0e7d9 2026-09-15 docs: 增加 HANDOFF.md
107df56 2026-09-15 chore: 接入 SkillsHub 工程流程约定
d86c8e0 2026-09-15 feat: merge concurrent ledger writers and drop unreachable knobs
cd686f7 2026-09-15 fix: correct metering, ledger and settings defects found by audit
```

近期主线是计量正确性：并发 ledger 写入合并（重读＋按 callId 合并，写前 fsync）、审计发现的 metering / settings 缺陷修复、provider 级定价的测试覆盖，以及连接链路的页面级渲染测试（`test/client-page-render.test.mjs`）——写这批测试时实测到一个缺陷：登录后的设置页从不做首次余额读取，只起了 5 分钟轮询，现已改为打开即读。

待定的一个设计取舍：`meter.deepseekBalance` 开关已按用户要求撤掉，因此插件无法再从**配置层面**禁止向 `api.deepseek.com` 发余额请求（`hideBalance` 只隐藏显示）。若要恢复“绝不外呼”的能力，应把它做成设置页里可达的开关，而不是只写在配置层的死开关。

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
