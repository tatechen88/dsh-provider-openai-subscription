# dsh-provider-openai-subscription

`dsh-provider-openai-subscription` 是 DeepSeek Harness（DSH）的独立 OpenAI／ChatGPT 订阅 Provider 插件。它通过 ChatGPT OAuth 凭据访问 Codex Responses 接口，为 DSH 提供模型发现、流式生成、订阅额度查询和 Web 设置界面。

> 本插件面向 ChatGPT/Codex 订阅的非公开接口，不等同于 OpenAI Platform API。正式使用前请确认账号、Client ID 与接口使用风险。

## 功能

- ChatGPT OAuth 登录：授权码、手动回调和设备码流程。
- 独立 Provider ID：`openai-subscription`，不与 `dsh-codex`、`dsh-codex-connect`、`llm-pi-ai/openai-codex` 抢占。
- OpenAI Responses 请求构造与 SSE 流式事件转换。
- 模型目录查询，包含上下文窗口与 reasoning effort 信息。
- Balance／使用额度查询，支持缓存、单飞刷新与过期数据回退。
- DSH Web 设置页、首启引导、模型列表与退出登录。
- 旧 `openai-codex` Provider 检测与迁移凭据加密备份。
- Rescue CLI：status / enable / disable / snapshot / rollback / install / doctor / canary。
- 安全 Bootstrap：插件失败不会阻止 DSH 启动。

## 设计目标

> 插件功能失败可以接受；导致本机 DSH 无法重启不可接受。

- Cordis 只加载 `src/index.js` 与 `src/bootstrap.js`。
- Runtime 只在 `state: active` 且配置非空 `oauth.clientId` 时动态加载。
- Runtime 加载或初始化失败会被捕获并转为禁用，不会抛给 DSH Loader。
- 提供独立 Rescue CLI，可在 DSH 无法启动时禁用插件。

## 与 DSH 权限模型的关系

Provider 把 DSH 工具 schema 投影为模型可见的 Responses 工具定义：普通工具参数保持原样，但 `sandbox_permissions` 与 `justification` 不会暴露给模型。

这两个字段是 DSH 内部经审批通道的一次性严格加宽控制参数，不是普通工具参数。当会话已处于 `danger-full-access` 时，DSH 会正确拒绝同级升级请求（`not strictly wider`），模型可能据此反复重试并卡住。隐藏字段后该循环不可达；受限文件策略拒绝命令时，模型应提示用户切换权限预设。

实现位置：`src/provider/request-builder.js` 的 `buildResponsesTools`。

## 安装（安全两阶段）

在 DSH 源码目录或已安装的 DSH 环境中加入插件：

```sh
dsh plugin --profile web add ../dsh-provider-openai-subscription
```

插件默认以 `bootstrap` 状态加入，不会加载 Runtime。需在 profile 中显式激活：

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

如需快速禁用：

```sh
dsh-openai-subscription-rescue disable
```

## 配置

| 字段 | 说明 |
|---|---|
| `state` | `bootstrap`、`disabled` 或 `active`；仅 `active` 加载 Runtime。 |
| `oauth.clientId` | OAuth Client ID；未配置时 Runtime 不加载。 |
| `provider.defaultModel` | 默认模型 ID，可留空。 |
| `provider.reasoningEffort` | 默认 reasoning effort，可留空。 |

Provider 使用独立的 Provider ID、设置命名空间与凭据键，不覆盖旧 `openai-codex` 的配置或凭据。

## Rescue CLI

```sh
# 查看脱敏状态
dsh-openai-subscription-rescue status

# 检查依赖与激活准备情况
dsh-openai-subscription-rescue doctor --profile path/to/profile/package.json

# 创建 / 回滚快照
dsh-openai-subscription-rescue snapshot
dsh-openai-subscription-rescue rollback

# 启用或禁用插件
dsh-openai-subscription-rescue enable
dsh-openai-subscription-rescue disable
```

凭据状态输出均脱敏。OAuth access token、refresh token 与密码不会写入日志或状态响应。

## 开发与测试

```sh
npm test                # 运行全部单元测试
npm run check           # 语法检查 + 全部单元测试
npm run test:integration  # 真实 DSH 组合 smoke（缺少依赖时安全跳过）
```

本地验证基线：180 个单元测试全部通过。

## 目录结构

```text
src/
  index.js                 Cordis 插件入口
  bootstrap.js             安全引导与失败隔离
  runtime.js               Runtime 装配（凭据/OAuth/额度/路由/adapter）
  config.js                配置归一化与激活判断
  state.js                 DSH_HOME 下的 kill switch 状态
  conflicts.js             Provider、namespace 与凭据冲突检查
  rescue.mjs               救援 CLI
  credentials/             凭据 schema、repository、token manager
  oauth/                   PKCE、state、JWT、callback、device code
  balance/                 Balance 客户端、归一化与缓存服务
  models/                  模型目录客户端
  provider/
    request-builder.js     Responses 请求构造与工具 schema 投影
    adapter.js             OpenAI 订阅 Provider adapter
    event-translator.js    Responses SSE → DSH chunk 转换
  stream/                  SSE parser
  web/                     本地同源 Web API 路由
client/
  client.js                设置页、首启引导与额度 UI
test/                     Node.js 单元测试
cordis.patch.yml           DSH bundle patch 定义
```

## 迁移与共存

插件会报告旧 `openai-codex` Provider 的存在，但不会复制、删除或刷新旧凭据。用户可用密码创建旧凭据的加密备份，再独立登录新 Provider。

新旧 Provider 使用不同凭据与设置命名空间，可自由切换。当前会话选择旧 Provider 时，插件不查询、不显示 `openai-subscription` 的 Balance，客户端与桌面壳也不请求上游额度接口。

## 已知限制

- 真实 OAuth、模型与 Balance live 验证需要真实账号与明确授权。
- ChatGPT/Codex 非公开接口可能发生协议变化。
- 高级模型配置 UI 尚未覆盖全部 Provider 参数。
- 修改源码后需让实际 DSH profile 重新加载插件；仅刷新浏览器页面不会更新已加载的 Runtime。

## 许可证

MIT
