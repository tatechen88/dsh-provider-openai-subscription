# dsh-provider-openai-subscription

独立的 DeepSeek Harness (DSH) 插件，计划提供：

- OpenAI / ChatGPT 订阅 OAuth 认证
- 独立的 OpenAI 模型 Provider
- 模型发现与流式调用
- 订阅 Balance / 使用额度查询
- DSH Web 登录 / 模型 / 额度 UI

本插件不使用旧 `openai-codex` Provider ID，不与 `dsh-codex`、`dsh-codex-connect`、`llm-pi-ai/openai-codex` 抢占 Provider。

## 安全引导（当前里程碑）

当前实现进度：

- 安全 Bootstrap：动态加载 runtime、kill switch、失败不阻断 DSH 启动
- 独立标识与冲突检查（provider id / settings namespace / credential key）
- Credential schema、repository、token manager（含 refresh single-flight）
- OAuth 核心：PKCE、state、JWT 元数据、token exchange/refresh、双栈 callback server、attempt manager、manual code、device-code
- Balance/usage：响应归一化、客户端、缓存/单飞/stale fallback
- Model catalog 客户端与 SSE parser
- OpenAI Provider adapter：Responses 请求构造、SSE 翻译、模型目录、`ctx.llm.registerAdapter` 注册
- 本地同源 Web API 路由（status / oauth start / attempt / code / cancel / logout / balance）
- 基础 Web settings card：登录、设备码、退出、Balance 展示、模型列表
- 侧边栏 Balance 指示条（当前模型为 openai-subscription 时显示）
- Rescue CLI：status / disable / enable / snapshot / rollback / install / doctor / canary
- 真实 DSH 组合 smoke：`npm run test:integration`

尚未完成：

- 真实 OAuth / 模型 / balance live 验证（需要真实账号与明确批准）
- 高级模型配置 UI（默认模型、reasoning effort 等）

设计目标：

> 插件功能失败可以接受；导致本机 DSH 无法重启不可接受。

实现方式：

- Cordis 只加载 `src/index.js` / `src/bootstrap.js`
- runtime 只在 `state: active` 且配置了 `oauth.clientId` 时才动态加载
- runtime 加载或初始化失败会被捕获并转为 disabled，不会抛给 DSH Loader
- 提供独立 rescue CLI，可在 DSH 无法启动时禁用插件

## 安装（安全两阶段）

手动本地安装时，插件会以 `bootstrap` 状态插入：

```sh
cd /path/to/DSH
dsh plugin --profile web add ../dsh-provider-openai-subscription
```

然后：

```sh
# 查看插件安全状态
dsh-openai-subscription-rescue status

# 只读 doctor / canary readiness
dsh-openai-subscription-rescue doctor --profile path/to/profile/package.json

# 需要禁用（例如怀疑插件影响启动）
dsh-openai-subscription-rescue disable
```

激活 runtime 需要显式修改 profile 中该 row 的配置：

```yaml
- id: llm-openai-subscription
  name: dsh-provider-openai-subscription
  config:
    state: active
    oauth:
      clientId: "<your-client-id>"
```

后续里程碑会提供自动兼容性检查、Shadow Profile Canary、激活回滚和 Web UI。

## 开发与测试

```sh
npm test
npm run check
```

## 目录

```text
src/
  index.js                 Cordis 插件入口
  bootstrap.js             安全引导（动态加载 runtime）
  runtime.js               runtime 装配（credentials/oauth/balance/routes）
  config.js                配置归一化与激活判断
  state.js                 DSH 插件状态 / kill switch
  conflicts.js             独立标识冲突检查
  rescue.mjs               独立救援 CLI
  credentials/
    schema.js              grant schema / 脱敏
    repository.js          ctx.credentials 记录读写
    token-manager.js       refresh / single-flight / reauth
  oauth/
    pkce.js                PKCE S256
    state.js               CSRF state
    jwt.js                 JWT 元数据提取
    token-client.js        token exchange / refresh
    callback-parser.js     手动回调输入解析
    callback-server.js     双栈 loopback callback
    attempt-manager.js     登录 attempt 状态机
  balance/
    types.js               balance DTO
    normalizer.js          wham/usage 归一化
    client.js              上游 usage 请求
    service.js             缓存 / 单飞 / stale fallback
  models/
    client.js              模型目录客户端
  stream/
    sse-parser.js          SSE 增量解析
  web/
    routes.js              本地同源 Web API
test/                      node:test 单元测试
```

## 风险声明

本插件面向 ChatGPT/Codex 订阅的非公开接口与 OAuth 流程，不是 OpenAI Platform API 官方计费方式。正式功能上线前需完成 Client ID 合法性确认、协议真实验证和风险确认。
