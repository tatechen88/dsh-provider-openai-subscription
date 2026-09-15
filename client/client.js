/**
 * Browser half of dsh-provider-openai-subscription.
 *
 * Renders four UI surfaces:
 * - a dedicated settings page (slot `settings.section`) where the user
 *   completes the OpenAI/ChatGPT OAuth connection and edits the meter;
 * - a first-run onboarding step (slot `settings.onboarding`) that prompts a
 *   blank session to connect while the plugin is active and signed out;
 * - the sidebar balance indicator (slot `sidebar.footer.action`), which the
 *   user can drag out of the sidebar into a floating panel whose position the
 *   browser remembers. Both that panel and the indicator's details card attach
 *   to the document body, because the seat lives inside a sidebar that clips
 *   its own subtree;
 * - a per-session usage line (slot `conversation.composer.dock`) that shares
 *   the indicator's data source.
 *
 * The browser never contacts OpenAI directly; all data flows through the
 * plugin's same-origin Host routes, which are already redacted.  UI copy is
 * bilingual (zh/en) and self-contained: the `locale` service is read
 * optionally through ctx.get('locale') with a navigator-language fallback, so
 * the bundle never depends on a service it did not declare.
 *
 * This file is a plain CommonJS module loaded by DSH's client module loader.
 */

window.__ModuleLoader__.load({ id: 'dsh-provider-openai-subscription', factory: (require) => {
  'use strict'

  const module = { exports: {} }

  const React = require('react')
  const { createElement: h, useEffect, useState, useCallback, useRef } = React
  // Platform module-table entry; guarded so a missing table never kills the factory.
  let primitives = null
  try {
    primitives = require('@deepseek-ai/dsh-client-ui-primitives')
  } catch {
    primitives = null
  }
  // Whether a floating element can be attached to the document body. Both the
  // sidebar and the composer dock clip their own subtree, and `overflow: hidden`
  // on an ancestor does clip a `position: fixed` descendant whenever that
  // ancestor is also its containing block — a rail that animates with a
  // transform does exactly that. Attaching to the body is the only placement
  // that cannot be cut off by whoever the indicator happens to be mounted in.
  let createPortal = null
  try {
    createPortal = require('react-dom').createPortal
  } catch {
    createPortal = null
  }

  const PACKAGE_NAME = 'dsh-provider-openai-subscription'
  const PROVIDER_ID = 'openai-subscription'
  /** DSH's official DeepSeek route, the second account the indicator follows. */
  const DEEPSEEK_PROVIDER_ID = 'deepseek-official'
  /** pi-ai's Z.AI coding-plan route, the third account the indicator follows. */
  const ZHIPU_PROVIDER_ID = 'zai-coding-cn'
  const SECTION_ID = 'openai-subscription'
  const ONBOARDING_STEP_ID = 'openai-subscription-connect'
  const SIDEBAR_ID = 'dsh-provider-openai-subscription-balance'
  const SESSION_DOCK_ID = 'dsh-provider-openai-subscription-usage'
  const STATUS_POLL_MS = 60 * 1000
  const BALANCE_POLL_MS = 5 * 60 * 1000
  /** Meter polling: fast enough to trail a call, slow enough to stay free. */
  const METER_POLL_MS = 30 * 1000
  /** localStorage slot remembering where the dragged balance panel sits. */
  const PANEL_STORE_KEY = 'dsh-provider-openai-subscription.balance-panel'
  /** Pointer travel, in px, that turns a press on the indicator into a drag. */
  const DRAG_THRESHOLD_PX = 4
  /** Gap kept between a floating panel and the viewport edge. */
  const FLOAT_MARGIN_PX = 4
  /** Gap kept between the floating panel and another visible control. */
  const COLLISION_GAP_PX = 8
  /** Controls considered occupied when a floating panel settles nearby. */
  const COLLISION_SELECTOR = 'button, a[href], input, textarea, select, [role="button"], [role="link"], [role="dialog"], [role="menu"], [role="toolbar"]'
  /**
   * Viewport width below which the meter indicator shows an icon instead of its
   * numbers. A phone reaching this harness remotely is narrower than any desktop
   * window, and there the numbers cannot fit the sidebar at all.
   */
  const NARROW_VIEWPORT_PX = 640
  /** Currencies the meter settings offer. A composition may still name another. */
  const DISPLAY_CURRENCIES = ['CNY', 'USD']
  /**
   * How long the details card stays open with nobody touching it. The card is a
   * reading, not a place to park: on a phone it covers the conversation, and a
   * card left open keeps showing numbers from the model the user has left.
   */
  const AUTO_COLLAPSE_MS = 12_000
  /**
   * Stacking order of the two floating elements: above the application chrome
   * (which tops out at 100) and below the modal layer (1000).
   */
  const FLOAT_Z_INDEX = 120

  const API = {
    status: '/plugins/openai-subscription/status',
    start: '/plugins/openai-subscription/oauth/start',
    attempt: '/plugins/openai-subscription/oauth/attempt',
    code: '/plugins/openai-subscription/oauth/code',
    cancel: '/plugins/openai-subscription/oauth/cancel',
    deviceStart: '/plugins/openai-subscription/oauth/device/start',
    deviceAttempt: '/plugins/openai-subscription/oauth/device/attempt',
    deviceCancel: '/plugins/openai-subscription/oauth/device/cancel',
    logout: '/plugins/openai-subscription/logout',
    balance: '/plugins/openai-subscription/balance',
    balanceRefresh: '/plugins/openai-subscription/balance/refresh',
    models: '/plugins/openai-subscription/models',
    modelsRefresh: '/plugins/openai-subscription/models/refresh',
    migrationBackup: '/plugins/openai-subscription/migration/backup',
    meterUsage: '/plugins/openai-subscription/meter/usage',
    meterSettings: '/plugins/openai-subscription/meter/settings',
  }

  /** Bilingual UI copy. Both dictionaries share the same key set. */
  const COPY = {
    zh: {
      nav: 'OpenAI 接入',
      heading: 'OpenAI (ChatGPT OAuth)',
      loading: '加载中…',
      currentProvider: '当前会话 Provider',
      providerNone: '未选择',
      signInState: '登录状态',
      signedIn: '已登录',
      signedOut: '未登录',
      notConfigured: '未配置',
      legacyProviderNotApplicable: '旧 Provider 不适用',
      retry: '重试',
      legacyDetected: '检测到旧 OpenAI OAuth',
      legacyBackupHint: '建议先备份',
      backupPasswordPlaceholder: '备份密码（至少 12 个字符）',
      backupAction: '加密备份旧 Provider',
      backupPasswordShort: '备份密码至少需要 12 个字符',
      backupDone: '旧 Provider 已加密备份：{backupId}',
      balance: 'Balance',
      balancePrimary: '5 小时额度',
      balanceSecondary: '每周额度',
      balancePrimaryShort: '5小时',
      balanceSecondaryShort: '每周',
      planType: '计划类型',
      refresh: '刷新',
      noBalance: '暂无 Balance 数据',
      resetsAt: '重置 {time}',
      noResetTime: '无重置时间',
      models: 'Models',
      noModels: '暂无模型数据',
      defaultModel: '默认模型',
      reasoningEffort: 'Reasoning Effort',
      logout: '退出登录',
      completeInBrowser: '请在浏览器完成登录',
      openAuthUrl: '打开授权页',
      pasteCodePlaceholder: '粘贴回调 URL 或 code',
      submit: '提交',
      cancel: '取消',
      devicePage: '打开设备码页面',
      deviceCode: '设备码',
      openDevice: '打开',
      loginChatGpt: '使用 ChatGPT 登录',
      loginDevice: '使用设备码登录',
      busyStarting: '启动中…',
      cardFullPanelHint: '完整面板在设置左侧的「OpenAI 接入」页',
      inactiveTitle: '插件未激活',
      inactiveBody: 'OpenAI 接入需要先在 profile 中配置 state: active 与 oauth.clientId，然后重启 DSH。',
      connectIntro: '使用 ChatGPT 账号登录后，即可使用订阅模型并查看使用额度。凭据仅保存在本机。',
      onboardingTitle: '连接 OpenAI 订阅',
      onboardingBody: '使用 ChatGPT / Codex 订阅账号登录，即可在 DSH 中使用 OpenAI 模型。',
      onboardingLater: '稍后配置',
      account: '账号',
      panelClickHint: '点击查看数据',
      panelDragHint: '拖动可移动位置，双击复位',
      panelClose: '关闭',
      meterTitle: '用量与费用',
      meterSession: '本会话',
      meterToday: '今日',
      meterMonth: '本月',
      meterTokens: 'Token',
      meterCacheHit: '缓存命中',
      meterEstimated: '估算',
      meterPublicPrice: '公开价',
      meterContractPrice: '合同价',
      meterNoPrice: '未配置价格',
      meterAccountUnknown: '未声明',
      meterAccountPersonal: '个人',
      meterAccountEnterprise: '企业（用户声明）',
      meterAccountHint: '公开 API 不返回实名类型，企业身份始终是用户声明。',
      meterDisplayCurrency: '显示币种',
      meterSave: '保存',
      meterSaved: '已保存',
      meterUnavailable: '余额不可用',
      meterNoUsage: '暂无用量',
      meterPriceSource: '价格来源',
      meterRemaining: '余',
      meterNoPlan: '无 Coding Plan 配额',
      meterBalance: '余额',
      meterSpent: '累计消费',
      meterUntil: '至',
      meterUses: '次',
      meterQuotaTokens: 'Token 额度',
      meterQuotaTimes: '次数额度',
      meterReadingUnavailable: '部分数据不可用',
      meterPriceRefreshFailed: '价格表刷新失败',
    },
    en: {
      nav: 'OpenAI Connect',
      heading: 'OpenAI (ChatGPT OAuth)',
      loading: 'Loading…',
      currentProvider: 'Current session provider',
      providerNone: 'Not selected',
      signInState: 'Sign-in state',
      signedIn: 'Signed in',
      signedOut: 'Not signed in',
      notConfigured: 'Not configured',
      legacyProviderNotApplicable: 'Not applicable to the legacy provider',
      retry: 'Retry',
      legacyDetected: 'Legacy OpenAI OAuth detected',
      legacyBackupHint: 'Back up before switching',
      backupPasswordPlaceholder: 'Backup password (at least 12 characters)',
      backupAction: 'Encrypt legacy provider backup',
      backupPasswordShort: 'Backup password must be at least 12 characters',
      backupDone: 'Legacy provider backed up: {backupId}',
      balance: 'Balance',
      balancePrimary: '5-hour limit',
      balanceSecondary: 'Weekly limit',
      balancePrimaryShort: '5h',
      balanceSecondaryShort: 'Weekly',
      planType: 'Plan',
      refresh: 'Refresh',
      noBalance: 'No balance data yet',
      resetsAt: 'Resets {time}',
      noResetTime: 'No reset time',
      models: 'Models',
      noModels: 'No model data yet',
      defaultModel: 'Default model',
      reasoningEffort: 'Reasoning Effort',
      logout: 'Sign out',
      completeInBrowser: 'Finish signing in in the browser',
      openAuthUrl: 'Open authorization page',
      pasteCodePlaceholder: 'Paste the callback URL or code',
      submit: 'Submit',
      cancel: 'Cancel',
      devicePage: 'Open the device-code page',
      deviceCode: 'Device code',
      openDevice: 'Open',
      loginChatGpt: 'Sign in with ChatGPT',
      loginDevice: 'Sign in with device code',
      busyStarting: 'Starting…',
      cardFullPanelHint: 'Full panel: OpenAI Connect in Settings',
      inactiveTitle: 'Plugin inactive',
      inactiveBody: 'OpenAI Connect requires state: active and oauth.clientId in the profile configuration; restart DSH afterwards.',
      connectIntro: 'Sign in with your ChatGPT account to use subscription models and view usage. Credentials stay on this machine.',
      onboardingTitle: 'Connect your OpenAI subscription',
      onboardingBody: 'Sign in with your ChatGPT / Codex subscription account to use OpenAI models in DSH.',
      onboardingLater: 'Configure later',
      account: 'Account',
      panelClickHint: 'Click for details',
      panelDragHint: 'Drag to move, double-click to reset',
      panelClose: 'Close',
      meterTitle: 'Usage and cost',
      meterSession: 'Session',
      meterToday: 'Today',
      meterMonth: 'Month',
      meterTokens: 'Tokens',
      meterCacheHit: 'Cache hit',
      meterEstimated: 'estimated',
      meterPublicPrice: 'Public price',
      meterContractPrice: 'Contract price',
      meterNoPrice: 'No configured price',
      meterAccountUnknown: 'Not declared',
      meterAccountPersonal: 'Personal',
      meterAccountEnterprise: 'Enterprise (user-declared)',
      meterAccountHint: 'The public API does not report verification type; enterprise identity is always user-declared.',
      meterDisplayCurrency: 'Display currency',
      meterSave: 'Save',
      meterSaved: 'Saved',
      meterUnavailable: 'Balance unavailable',
      meterNoUsage: 'No usage yet',
      meterPriceSource: 'Price source',
      meterRemaining: 'left',
      meterNoPlan: 'No coding-plan quota',
      meterBalance: 'Balance',
      meterSpent: 'Spent',
      meterUntil: 'until',
      meterUses: 'uses',
      meterQuotaTokens: 'token quota',
      meterQuotaTimes: 'uses quota',
      meterReadingUnavailable: 'Some readings unavailable',
      meterPriceRefreshFailed: 'Price table refresh failed',
    },
  }

  /**
   * Resolve one copy key against a language dictionary, replacing {param}
   * tokens. Unknown keys surface as the key itself.
   * @param {string} lang
   * @param {string} key
   * @param {object} [params]
   * @returns {string}
   */
  function translate(lang, key, params) {
    const dict = COPY[lang] || COPY.zh
    const raw = dict[key]
    if (typeof raw !== 'string') return key
    if (params === undefined) return raw
    return raw.replace(/\{(\w+)\}/g, (match, token) => (token in params ? String(params[token]) : match))
  }

  /**
   * Map an active locale id (or a browser language) onto the zh/en pair.
   * @param {string} [active] - active locale id from the locale service.
   * @param {string} [browserLang] - navigator.language fallback.
   * @returns {'zh'|'en'}
   */
  function pickLanguage(active, browserLang) {
    const candidate = (typeof active === 'string' && active.length > 0) ? active : browserLang
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }
    return 'zh'
  }

  /**
   * Derive the page state kind from a successful /status read.
   * @param {boolean} fetchOk - whether the /status route answered at all.
   * @param {boolean|undefined} configured - the status payload's configured flag.
   * @returns {'inactive'|'unconfigured'|'signedIn'}
   */
  function deriveStatusKind(fetchOk, configured) {
    if (fetchOk !== true) return 'inactive'
    return configured === true ? 'signedIn' : 'unconfigured'
  }

  /**
   * Derive the onboarding step's decision from the flow kind.
   * @param {string} kind - one flow kind.
   * @returns {'deciding'|'skip'|'prompt'|'error'}
   */
  function deriveOnboardingDecision(kind) {
    switch (kind) {
      case 'loading':
        return 'deciding'
      case 'inactive':
      case 'signedIn':
        return 'skip'
      case 'unconfigured':
        return 'prompt'
      case 'error':
        return 'error'
      default:
        return 'skip'
    }
  }

  /**
   * Read the current language without subscribing (label thunks and tests).
   * @param {(() => object|undefined)|undefined} getLocale
   * @returns {'zh'|'en'}
   */
  function currentLanguage(getLocale) {
    let active
    try {
      const locale = typeof getLocale === 'function' ? getLocale() : undefined
      if (locale !== undefined && typeof locale.getSnapshot === 'function') {
        const snapshot = locale.getSnapshot()
        if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.active === 'string') {
          active = snapshot.active
        }
      }
    } catch {
      active = undefined
    }
    const browserLang = typeof navigator !== 'undefined' && typeof navigator.language === 'string'
      ? navigator.language
      : undefined
    return pickLanguage(active, browserLang)
  }

  /**
   * Stateless translate bound to the live locale (for slot label thunks).
   * @param {(() => object|undefined)|undefined} getLocale
   * @param {string} key
   * @param {object} [params]
   * @returns {string}
   */
  function tNow(getLocale, key, params) {
    return translate(currentLanguage(getLocale), key, params)
  }

  /**
   * How long a same-origin request may take before this surface stops waiting
   * on it.
   *
   * The slowest server-side path is the model catalogue's own 30s upstream
   * timeout, so the client bound has to sit above that: the point is to stop a
   * hung connection from piling up pending polls forever, not to race the
   * server's own bound.
   */
  const REQUEST_TIMEOUT_MS = 45_000

  async function getJson(url, options) {
    const response = await fetch(url, {
      ...(options || {}),
      headers: { accept: 'application/json', ...((options && options.headers) || {}) },
      cache: 'no-store',
      // A caller-supplied signal keeps priority; the timeout is only the floor
      // that stops a wedged connection from holding a poll open forever.
      signal: options?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    const payload = await response.json().catch(() => ({}))
    // A degraded route answers 200 with `ok:false` instead of failing the
    // request, so the status alone cannot decide that a call succeeded.
    if (!response.ok || (payload && payload.ok === false)) {
      const error = new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`)
      error.status = response.status
      error.payload = payload
      throw error
    }
    return payload
  }

  function postJson(url, body) {
    return getJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
  }

  /**
   * Partial update. The settings route merges a patch over the stored section
   * under a revision, so it is a PATCH rather than a POST.
   * @param {string} url
   * @param {object} body
   * @returns {Promise<object>}
   */
  function patchJson(url, body) {
    return getJson(url, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
  }

  function messageOf(error) {
    return error instanceof Error ? error.message : String(error)
  }

  function formatTime(ts) {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return undefined
    return new Date(ts).toLocaleString()
  }

  const s = {
    card: { fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: 13, lineHeight: '20px', color: '#e5e7eb', padding: 4 },
    page: { fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: 13, lineHeight: '20px', color: '#e5e7eb', padding: '4px 2px', maxWidth: 720 },
    row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '4px 0' },
    stack: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 },
    button: { background: '#1f2937', color: '#f9fafb', border: '1px solid #374151', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12 },
    buttonDisabled: { opacity: 0.6, cursor: 'default' },
    link: { color: '#93c5fd', wordBreak: 'break-all' },
    error: { color: '#fca5a5', margin: '6px 0' },
    success: { color: '#86efac', margin: '6px 0' },
    note: { color: '#9ca3af', margin: '6px 0' },
    input: { width: '100%', boxSizing: 'border-box', background: '#111827', color: '#f9fafb', border: '1px solid #374151', borderRadius: 8, padding: 6, margin: '6px 0' },
    block: { marginTop: 8, borderTop: '1px solid #374151', paddingTop: 8 },
    intro: { color: '#d1d5db', margin: '4px 0 8px' },
    title: { margin: '0 0 8px', fontSize: 16 },
    cardTitle: { margin: '0 0 8px', fontSize: 14 },
    sessionDock: { textAlign: 'center', fontSize: 12, lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary, #9ca3af)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    checkRow: { display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' },
    textarea: { width: '100%', boxSizing: 'border-box', background: '#111827', color: '#f9fafb', border: '1px solid #374151', borderRadius: 8, padding: 6, margin: '6px 0', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
  }

  function selectionFromStore(store) {
    if (!store || typeof store.getSnapshot !== 'function') return null
    const snapshot = store.getSnapshot()
    return snapshot && snapshot.current && typeof snapshot.current.provider === 'string'
      ? snapshot.current
      : null
  }

  /**
   * Identity of the session the page currently shows.
   * @param {object|undefined} sessionsService
   * @returns {string|undefined}
   */
  function currentSessionId(sessionsService) {
    try {
      const snapshot = sessionsService?.list?.getSnapshot?.()
      return snapshot !== null && typeof snapshot === 'object' && typeof snapshot.current === 'string'
        ? snapshot.current
        : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Follow the current session's provider through the sessions ledger and the
   * per-session model directory.
   * @param {object|undefined} sessionsService
   * @param {object|undefined} modelDirectories
   * @returns {string|null} the current provider id, null while unknown.
   */
  function useCurrentProvider(sessionsService, modelDirectories) {
    const [provider, setProvider] = useState(null)
    useEffect(() => {
      if (!sessionsService || !sessionsService.list || !modelDirectories) return undefined
      let stopList
      function sync() {
        try {
          const list = sessionsService.list.getSnapshot()
          const current = list && typeof list.current === 'string' ? list.current : null
          if (current === null) {
            setProvider(null)
            return
          }
          const directory = modelDirectories.directoryFor(current)
          const selection = selectionFromStore(directory && directory.store)
          setProvider(selection ? selection.provider : null)
        } catch {
          setProvider(null)
        }
      }
      sync()
      stopList = sessionsService.list.subscribe(sync)
      return () => {
        if (typeof stopList === 'function') stopList()
      }
    }, [sessionsService, modelDirectories])
    return provider
  }

  /**
   * Identity of the session the page currently shows, as reactive state.
   *
   * The per-session usage line has to reload when the session changes even if
   * both sessions resolve to the same provider: the provider is not the key its
   * numbers belong to, and a provider-only dependency would leave the previous
   * session's totals on screen until the next poll.
   *
   * @param {object|undefined} sessionsService
   * @returns {string|null}
   */
  function useCurrentSessionId(sessionsService) {
    const [sessionId, setSessionId] = useState(null)
    useEffect(() => {
      if (!sessionsService || !sessionsService.list || typeof sessionsService.list.subscribe !== 'function') return undefined
      const sync = () => setSessionId(currentSessionId(sessionsService) ?? null)
      sync()
      const stop = sessionsService.list.subscribe(sync)
      return () => {
        if (typeof stop === 'function') stop()
      }
    }, [sessionsService])
    return sessionId
  }

  /**
   * Reactively follow the active locale when a locale service is available.
   * @param {(() => object|undefined)|undefined} getLocale
   * @returns {'zh'|'en'}
   */
  function useLocaleLang(getLocale) {
    const [lang, setLang] = useState(() => currentLanguage(getLocale))
    useEffect(() => {
      let locale
      try {
        locale = typeof getLocale === 'function' ? getLocale() : undefined
      } catch {
        locale = undefined
      }
      if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
      const sync = () => setLang(currentLanguage(getLocale))
      sync()
      return locale.subscribe(sync)
    }, [getLocale])
    return lang
  }

  /** Reactive translate bound to a component's props. */
  function useT(getLocale) {
    const lang = useLocaleLang(getLocale)
    return useCallback((key, params) => translate(lang, key, params), [lang])
  }

  /**
   * Shared connection-flow controller for the card, page, and onboarding step.
   * Every route call is same-origin and redacted; failures surface as text.
   * @param {object} options
   * @param {string|null} options.provider - current session provider id; the
   * balance client only runs while it equals PROVIDER_ID.
   * @returns {object} view state plus actions.
   */
  function useOpenAISubscriptionFlow({ provider }) {
    const [view, setView] = useState({
      kind: 'loading',
      status: null,
      balance: null,
      models: [],
      error: null,
      busy: false,
    })
    const [attempt, setAttempt] = useState(null)
    const [deviceAttempt, setDeviceAttempt] = useState(null)
    const patch = (part) => setView((previous) => ({ ...previous, ...part }))

    const refreshStatus = async () => {
      try {
        const payload = await getJson(API.status)
        const configured = Boolean(payload && payload.data && payload.data.configured === true)
        patch({ kind: deriveStatusKind(true, configured), status: payload ? payload.data : null, error: null })
        return configured
      } catch (error) {
        if (error && error.status === 404) {
          patch({ kind: 'inactive', status: null, error: null })
        } else {
          patch({ kind: 'error', error: messageOf(error) })
        }
        return false
      }
    }

    const refreshBalance = async (force) => {
      if (provider !== PROVIDER_ID) {
        patch({ balance: null })
        return
      }
      try {
        const payload = force
          ? await postJson(API.balanceRefresh, { provider })
          : await getJson(`${API.balance}?provider=${encodeURIComponent(provider)}`)
        patch({ balance: payload && payload.data ? payload.data : null })
      } catch (error) {
        patch({ error: messageOf(error) })
      }
    }

    const refreshModels = async () => {
      try {
        const payload = await getJson(API.models)
        patch({ models: payload && Array.isArray(payload.data) ? payload.data : [] })
      } catch (error) {
        patch({ error: messageOf(error) })
      }
    }

    const afterSignedIn = async () => {
      await refreshBalance(true)
      void refreshModels()
    }

    const startLogin = async () => {
      patch({ busy: true, error: null })
      try {
        const payload = await postJson(API.start)
        setAttempt(payload && payload.data ? payload.data : null)
      } catch (error) {
        patch({ error: messageOf(error) })
      } finally {
        patch({ busy: false })
      }
    }

    /**
     * Submit a manual callback URL or code for the active attempt.
     * @param {string} input
     * @returns {Promise<boolean>} true when the exchange signed the user in.
     */
    const submitCode = async (input) => {
      if (attempt === null) return false
      patch({ busy: true, error: null })
      try {
        await postJson(API.code, { attemptId: attempt.attemptId, input: input.trim() })
        setAttempt(null)
        const configured = await refreshStatus()
        if (configured) await afterSignedIn()
        return configured === true
      } catch (error) {
        patch({ error: messageOf(error) })
        return false
      } finally {
        patch({ busy: false })
      }
    }

    const cancelLogin = async () => {
      if (attempt === null) return
      try {
        await postJson(API.cancel, { attemptId: attempt.attemptId })
      } catch {
        // cancelling a vanished attempt is a no-op
      } finally {
        setAttempt(null)
      }
    }

    const startDevice = async () => {
      patch({ busy: true, error: null })
      try {
        const payload = await postJson(API.deviceStart)
        setDeviceAttempt(payload && payload.data ? payload.data : null)
      } catch (error) {
        patch({ error: messageOf(error) })
      } finally {
        patch({ busy: false })
      }
    }

    const cancelDevice = async () => {
      if (deviceAttempt === null) return
      try {
        await postJson(API.deviceCancel, { attemptId: deviceAttempt.attemptId })
      } catch {
        // cancelling a vanished attempt is a no-op
      } finally {
        setDeviceAttempt(null)
      }
    }

    const logout = async () => {
      patch({ busy: true, error: null })
      try {
        await postJson(API.logout)
      } catch (error) {
        patch({ error: messageOf(error) })
      } finally {
        setAttempt(null)
        setDeviceAttempt(null)
        patch({ busy: false, kind: 'unconfigured', status: { configured: false }, balance: null, models: [] })
        void refreshStatus()
      }
    }

    /**
     * Encrypt a password-escrowed backup of the legacy credential.
     * @param {string} password
     * @returns {Promise<string>} backup id, empty when the call failed.
     */
    const backupLegacy = async (password) => {
      patch({ busy: true, error: null })
      try {
        const payload = await postJson(API.migrationBackup, { password })
        const id = payload && payload.data && typeof payload.data.backupId === 'string' ? payload.data.backupId : ''
        return id
      } catch (error) {
        patch({ error: messageOf(error) })
        return ''
      } finally {
        patch({ busy: false })
      }
    }

    useEffect(() => {
      let alive = true
      void (async () => {
        try {
          const payload = await getJson(API.status)
          if (!alive) return
          const configured = Boolean(payload && payload.data && payload.data.configured === true)
          patch({ kind: deriveStatusKind(true, configured), status: payload ? payload.data : null })
        } catch (error) {
          if (!alive) return
          if (error && error.status === 404) {
            patch({ kind: 'inactive' })
          } else {
            patch({ kind: 'error', error: messageOf(error) })
          }
        }
      })()
      return () => { alive = false }
    }, [])

    useEffect(() => {
      const timer = setInterval(() => { void refreshStatus() }, STATUS_POLL_MS)
      return () => clearInterval(timer)
    }, [])

    useEffect(() => {
      if (view.kind !== 'signedIn') return undefined
      void refreshModels()
      // The first reading is taken on open: leaving it to the poll interval
      // shows an empty balance block for five minutes after every page load.
      void refreshBalance(false)
      const timer = setInterval(() => { void refreshBalance(false) }, BALANCE_POLL_MS)
      return () => clearInterval(timer)
    }, [view.kind, provider])

    return {
      ...view,
      attempt,
      deviceAttempt,
      refreshStatus,
      refreshBalance,
      refreshModels,
      startLogin,
      submitCode,
      cancelLogin,
      startDevice,
      cancelDevice,
      logout,
      backupLegacy,
    }
  }

  function Row({ label, children, value }) {
    return h('div', { style: s.row }, [
      h('span', null, label),
      children !== undefined ? children : h('span', null, value === undefined ? '' : value),
    ])
  }

  /** Localized label for a balance window; primary/secondary use official copy. */
  function windowLabel(t, window) {
    if (window.id === 'primary') return t('balancePrimary')
    if (window.id === 'secondary') return t('balanceSecondary')
    return window.label || window.id
  }

  /** Compact label for the narrow sidebar indicator. */
  function windowShortLabel(t, window) {
    if (window.id === 'primary') return t('balancePrimaryShort')
    if (window.id === 'secondary') return t('balanceSecondaryShort')
    return window.label || window.id
  }

  /**
   * Localized label for one Zhipu coding-plan quota window.
   *
   * The station names its windows by a protocol type and a length in hours, so
   * two token windows of one account stay apart only through that length.
   */
  function quotaWindowLabel(t, window) {
    const hours = typeof window.unit === 'number' && Number.isFinite(window.unit) && window.unit > 0
      ? `${window.unit}h`
      : ''
    if (window.type === 'TOKENS_LIMIT') return `${hours} ${t('meterQuotaTokens')}`.trim()
    if (window.type === 'TIME_LIMIT') return t('meterQuotaTimes')
    return window.type || window.id
  }

  function ActionButton({ label, disabled, onClick }) {
    return h('button', {
      type: 'button',
      style: disabled === true ? { ...s.button, ...s.buttonDisabled } : s.button,
      disabled: disabled === true,
      onClick,
    }, label)
  }

  /**
   * The login surface shared by the page, the card, and the onboarding step:
   * authorization-code flow (auth URL + manual callback input) and the
   * device-code flow.
   * @param {object} props
   * @param {object} props.flow - useOpenAISubscriptionFlow result.
   * @param {(key: string, params?: object) => string} props.t
   * @param {() => void} [props.onSignedIn] - invoked once the exchange lands.
   * @returns {object} element tree.
   */
  function LoginFlow({ flow, t, onSignedIn }) {
    const [code, setCode] = useState('')
    const submit = async () => {
      if (code.trim().length === 0 || flow.attempt === null) return
      const signedIn = await flow.submitCode(code)
      if (signedIn) {
        setCode('')
        if (typeof onSignedIn === 'function') onSignedIn()
      }
    }
    const busy = flow.busy === true

    if (flow.attempt !== null) {
      return h('div', null, [
        h('div', { style: s.row }, [
          h('span', null, t('completeInBrowser')),
          h('a', { href: flow.attempt.url, target: '_blank', rel: 'noreferrer', style: s.link }, t('openAuthUrl')),
        ]),
        h('input', {
          type: 'text',
          value: code,
          onChange: (event) => setCode(event.target.value),
          placeholder: t('pasteCodePlaceholder'),
          style: s.input,
        }),
        h('div', { style: { display: 'flex', gap: 8 } }, [
          h(ActionButton, { label: t('submit'), disabled: busy, onClick: () => { void submit() } }),
          h(ActionButton, { label: t('cancel'), disabled: busy, onClick: () => { void flow.cancelLogin() } }),
        ]),
      ])
    }

    if (flow.deviceAttempt !== null) {
      return h('div', null, [
        h('div', { style: s.row }, [
          h('span', null, t('devicePage')),
          h('a', { href: flow.deviceAttempt.verificationUri, target: '_blank', rel: 'noreferrer', style: s.link }, t('openDevice')),
        ]),
        h('div', { style: s.row }, [
          h('span', null, t('deviceCode')),
          h('strong', null, flow.deviceAttempt.userCode),
        ]),
        h('div', { style: { display: 'flex', gap: 8 } }, [
          h(ActionButton, { label: t('cancel'), disabled: busy, onClick: () => { void flow.cancelDevice() } }),
        ]),
      ])
    }

    return h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
      h(ActionButton, {
        label: busy ? t('busyStarting') : t('loginChatGpt'),
        disabled: busy,
        onClick: () => { void flow.startLogin() },
      }),
      h(ActionButton, {
        label: busy ? t('busyStarting') : t('loginDevice'),
        disabled: busy,
        onClick: () => { void flow.startDevice() },
      }),
    ])
  }

  /**
   * Password-escrowed backup surface for a detected legacy credential.
   * @param {object} props
   * @param {object} props.status - the /status payload (holds `migration`).
   * @param {object} props.flow
   * @param {object} props.t
   * @returns {object} element tree or null when no legacy credential exists.
   */
  function MigrationPanel({ status, flow, t }) {
    const [password, setPassword] = useState('')
    const [feedback, setFeedback] = useState({ error: null, info: null })
    const migration = status && status.migration ? status.migration : undefined
    if (migration === undefined || (migration.providerPresent !== true && migration.credentialPresent !== true)) {
      return null
    }
    const backup = async () => {
      if (password.length < 12) {
        setFeedback({ error: t('backupPasswordShort'), info: null })
        return
      }
      setFeedback({ error: null, info: null })
      const backupId = await flow.backupLegacy(password)
      if (backupId.length > 0) {
        setPassword('')
        setFeedback({ error: null, info: t('backupDone', { backupId }) })
      }
    }
    return h('div', { style: s.block }, [
      h('div', { style: s.row }, [
        h('span', null, t('legacyDetected')),
        h('span', null, t('legacyBackupHint')),
      ]),
      feedback.error !== null ? h('div', { style: s.error, role: 'alert' }, feedback.error) : null,
      feedback.info !== null ? h('div', { style: s.success }, feedback.info) : null,
      h('input', {
        type: 'password',
        value: password,
        onChange: (event) => setPassword(event.target.value),
        placeholder: t('backupPasswordPlaceholder'),
        style: s.input,
      }),
      h(ActionButton, {
        label: t('backupAction'),
        disabled: flow.busy === true,
        onClick: () => { void backup() },
      }),
    ])
  }

  /**
   * The signed-in panel: account, balance windows, model catalog, provider
   * defaults, and the logout action.
   * @param {object} props
   * @param {object} props.flow
   * @param {string|null} props.currentProvider
   * @param {object} props.t
   * @returns {object} element tree.
   */
  function SignedInPanel({ flow, currentProvider, t }) {
    const status = flow.status || {}
    const grant = status.grant
    const providerDefault = status.provider
    const windows = flow.balance && Array.isArray(flow.balance.windows) ? flow.balance.windows : []
    const plan = flow.balance && typeof flow.balance.plan === 'string' && flow.balance.plan.length > 0
      ? flow.balance.plan
      : undefined

    const balanceRows = windows.length > 0
      ? windows.map((window) => h(Row, {
          key: window.id || window.label,
          label: `${windowLabel(t, window)}: ${window.remainingPercent}%`,
          value: window.resetsAt !== undefined ? t('resetsAt', { time: formatTime(window.resetsAt) || '' }) : t('noResetTime'),
        }))
      : [h(Row, { key: 'no-balance', label: t('noBalance') })]

    const modelRows = flow.models.length > 0
      ? flow.models.slice(0, 20).map((model) => h(Row, {
          key: model.id,
          label: model.name || model.id,
          value: model.id,
        }))
      : [h(Row, { key: 'no-models', label: t('noModels') })]

    return h('div', null, [
      grant !== undefined
        ? h(Row, {
            key: 'account',
            label: t('account'),
            value: `${grant.accountId}${grant.email ? ` · ${grant.email}` : ''}`,
          })
        : null,
      h('div', { key: 'balance-block', style: s.block }, [
        h('div', { style: s.row }, [
          h('span', null, t('balance')),
          h(ActionButton, {
            label: t('refresh'),
            disabled: flow.busy === true,
            onClick: () => { void flow.refreshBalance(true) },
          }),
        ]),
        plan !== undefined
          ? h(Row, { key: 'plan', label: t('planType'), value: `${plan.charAt(0).toUpperCase()}${plan.slice(1)}` })
          : null,
        currentProvider === 'openai-codex'
          ? h(Row, { key: 'legacy-note', label: t('legacyProviderNotApplicable') })
          : h('div', { style: s.stack }, balanceRows),
      ]),
      h('div', { key: 'models-block', style: s.block }, [
        h('div', { style: s.row }, [
          h('span', null, t('models')),
          h(ActionButton, {
            label: t('refresh'),
            disabled: flow.busy === true,
            onClick: () => { void flow.refreshModels() },
          }),
        ]),
        h('div', { style: s.stack }, modelRows),
      ]),
      providerDefault !== undefined
        ? h('div', { key: 'provider-config', style: s.block }, [
            h(Row, { label: t('defaultModel'), value: providerDefault.defaultModel || '' }),
            h(Row, { label: t('reasoningEffort'), value: providerDefault.reasoningEffort || '' }),
          ])
        : null,
      h('div', { key: 'logout', style: s.block }, [
        h(ActionButton, {
          label: t('logout'),
          disabled: flow.busy === true,
          onClick: () => { void flow.logout() },
        }),
      ]),
    ])
  }

  /**
   * Meter settings: the display currency, and nothing else.
   *
   * Everything else the meter understands is composition-level configuration in
   * `cordis.patch.yml`: the account declaration, the statistics zone, whether the
   * official balance is read at all, and the two privacy switches. Those are
   * deployment decisions, so the page keeps the one choice that is the user's.
   *
   * @param {object} props
   * @param {(key: string) => string} props.t - translator for the active locale.
   * @returns {object|null} element tree, or null until the settings load.
   */
  function MeterSettingsPanel({ t }) {
    const [state, setState] = useState(null)
    const [draft, setDraft] = useState(null)
    const [notice, setNotice] = useState(null)

    useEffect(() => {
      let cancelled = false
      async function load() {
        try {
          const payload = await getJson(API.meterSettings)
          if (cancelled) return
          setState({ revision: payload.data.revision, config: payload.data.config })
          setDraft(payload.data.config)
        } catch {
          if (!cancelled) setNotice('unavailable')
        }
      }
      load()
      return () => { cancelled = true }
    }, [])

    if (state === null || draft === null) return null

    const patch = (next) => setDraft({ ...draft, ...next })
    const save = async () => {
      try {
        // Only what changed: sending the whole editable configuration back
        // would copy today's composition defaults into the user layer, after
        // which editing the composition would stop having any effect.
        const changes = {}
        for (const [key, value] of Object.entries(draft)) {
          if (JSON.stringify(state.config[key]) !== JSON.stringify(value)) changes[key] = value
        }
        if (Object.keys(changes).length === 0) {
          setNotice('saved')
          return
        }
        const payload = await patchJson(API.meterSettings, { patch: changes, expectedRevision: state.revision })
        setState({ revision: payload.data.revision, config: payload.data.config })
        setDraft(payload.data.config)
        setNotice('saved')
      } catch (error) {
        // A conflict leaves this panel holding a revision the store has already
        // moved past. Adopting the current one is what makes a retry work;
        // without it every later save conflicts for the same reason.
        const actualRevision = error && error.payload ? error.payload.actualRevision : undefined
        if (Number.isSafeInteger(actualRevision)) setState({ revision: actualRevision, config: state.config })
        // A conflict or a rejected value is something the user must see; a
        // silent failure would look like the save worked.
        setNotice(messageOf(error))
      }
    }
    // A composition may name a currency this panel does not offer; it is then
    // appended, so the select shows the value in force instead of going blank.
    const currencies = DISPLAY_CURRENCIES.includes(draft.displayCurrency)
      ? DISPLAY_CURRENCIES
      : [...DISPLAY_CURRENCIES, draft.displayCurrency]

    return h('div', { style: s.block }, [
      h('h3', { style: s.cardTitle, key: 'title' }, t('meterTitle')),
      h('div', { key: 'display', style: s.row }, [
        h('span', null, t('meterDisplayCurrency')),
        h('select', {
          style: s.input,
          value: draft.displayCurrency,
          onChange: (event) => patch({ displayCurrency: event.target.value }),
        }, currencies.map((code) => h('option', { key: code, value: code }, code))),
      ]),
      h('div', { key: 'actions', style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } }, [
        h(ActionButton, { key: 'save', label: t('meterSave'), onClick: () => { void save() } }),
        notice === null || notice === 'unavailable'
          ? null
          : h('span', {
              key: 'notice',
              style: notice === 'saved' ? s.success : s.error,
              role: notice === 'saved' ? undefined : 'alert',
            }, notice === 'saved' ? t('meterSaved') : notice),
      ]),
    ])
  }

  /**
   * The shared connection content: inactive guidance, login flow, signed-in
   * panel, and legacy migration in one vertical arrangement.
   * @param {object} props
   * @param {object} props.flow
   * @param {string|null} props.currentProvider
   * @param {object} props.t
   * @param {boolean} [props.page] - full-page layout (intro copy, spacing).
   * @returns {object} element tree.
   */
  function OpenAISubscriptionContent({ flow, currentProvider, t, page }) {
    const kind = flow.kind
    const signedIn = kind === 'signedIn'
    const ready = signedIn || kind === 'unconfigured'

    const statusLine = h(Row, {
      key: 'sign-in-state',
      label: t('signInState'),
      value: signedIn ? t('signedIn') : t('signedOut'),
    })
    const providerLine = h(Row, {
      key: 'current-provider',
      label: t('currentProvider'),
      value: currentProvider || t('providerNone'),
    })

    return h('div', null, [
      flow.error !== null ? h('div', { key: 'error', style: s.error, role: 'alert' }, flow.error) : null,
      kind === 'loading'
        ? h(Row, { key: 'loading', label: t('loading') })
        : null,
      kind === 'inactive'
        ? h('div', { key: 'inactive' }, [
            h('strong', null, t('inactiveTitle')),
            h('p', { style: s.intro }, t('inactiveBody')),
          ])
        : null,
      kind === 'error'
        ? h('div', { key: 'flow-error' }, [
            h('p', { style: s.error, role: 'alert' }, flow.error),
            h(ActionButton, { label: t('retry'), onClick: () => { void flow.refreshStatus() } }),
          ])
        : null,
      ready
        ? h('div', { key: 'ready' }, [
            page === true && !signedIn ? h('p', { style: s.intro }, t('connectIntro')) : null,
            providerLine,
            statusLine,
            h(MigrationPanel, { key: 'migration', status: flow.status || {}, flow, t }),
            signedIn
              ? h(SignedInPanel, { key: 'signed-in', flow, currentProvider, t })
              : h(LoginFlow, { key: 'login', flow, t }),
            // Settings belong to the page: the compact card keeps the connection
            // controls only, so a plugin card never grows a second settings form.
            page === true ? h(MeterSettingsPanel, { key: 'meter', t }) : null,
          ])
        : null,
    ])
  }

  function OpenAISubscriptionPage(props) {
    const { sessionsService, modelDirectories, getLocale } = props
    const t = useT(getLocale)
    const currentProvider = useCurrentProvider(sessionsService, modelDirectories)
    // This page is the OpenAI account's own panel, so its quota must not depend
    // on which provider the current session happens to run: on a DeepSeek
    // session the balance block would sit empty forever and its refresh button
    // would do nothing at all.
    const flow = useOpenAISubscriptionFlow({ provider: PROVIDER_ID })
    return h('div', { style: s.page }, [
      h('h2', { style: s.title }, t('heading')),
      h(OpenAISubscriptionContent, { flow, currentProvider, t, page: true }),
    ])
  }

  /**
   * First-run onboarding step. Decides from /status: signed-in and inactive
   * states complete immediately (and render null), a signed-out active plugin
   * prompts inside a blocking modal, and an unreachable status keeps the step
   * hidden while it is loading.
   * @param {object} props - owner props plus the inject face.
   * @param {string} props.stepId - step id selected by the coordinator.
   * @param {() => void} props.complete - transfer ownership to the next step.
   * @param {(id: string) => void} props.openSection - open settings on a section.
   * @returns {object|null} the modal tree or null while deciding/skipping.
   */
  function OpenAISubscriptionOnboardingStep(props) {
    const { complete, getLocale } = props
    const t = useT(getLocale)
    const flow = useOpenAISubscriptionFlow({ provider: null })
    const finished = useRef(false)
    const finish = useCallback(() => {
      if (finished.current) return
      finished.current = true
      complete()
    }, [complete])
    const decision = deriveOnboardingDecision(flow.kind)

    useEffect(() => {
      if (decision === 'skip') finish()
    }, [decision, finish])

    if (decision === 'deciding' || decision === 'skip') return null

    const laterButton = primitives && primitives.Button
      ? h(primitives.Button, { variant: 'ghost', size: 'md', onClick: finish }, t('onboardingLater'))
      : h(ActionButton, { label: t('onboardingLater'), onClick: finish })

    const body = h('div', { style: { padding: '0 2px' } }, [
      h('h2', { style: { ...s.title, fontSize: 15 } }, t('onboardingTitle')),
      decision === 'error'
        ? h('p', { style: s.error, role: 'alert' }, flow.error)
        : h('p', { style: s.intro }, t('onboardingBody')),
      decision === 'prompt' ? h(LoginFlow, { flow, t, onSignedIn: finish }) : null,
      h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } }, [laterButton]),
    ])

    if (primitives && primitives.Modal) {
      return h(primitives.Modal, {
        open: true,
        onClose: () => {},
        title: t('onboardingTitle'),
        headless: true,
      }, body)
    }
    // Fallback chrome when the primitives module is unavailable.
    return h('div', {
      style: { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(2,6,23,0.6)' },
    }, [
      h('div', { style: { background: '#111827', border: '1px solid #374151', borderRadius: 12, padding: 18, maxWidth: 430, width: '92%', color: '#e5e7eb' } }, body),
    ])
  }

  /** Currency symbols the indicator can print; unknown codes render as the code. */
  const CURRENCY_SYMBOLS = { CNY: '¥', USD: '$', EUR: '€' }

  /**
   * Format a fixed-point micro amount for display.
   *
   * Amounts arrive as integer micro units so the Host never ships a float that
   * rounds differently on a second render.
   * @param {unknown} micros - integer micro units of the currency.
   * @param {string|undefined} currency
   * @returns {string|undefined} e.g. "¥0.42", or undefined when there is nothing to show.
   */
  function formatAmount(micros, currency) {
    if (typeof micros !== 'number' || !Number.isFinite(micros)) return undefined
    // An own-property lookup: a currency name like `constructor` would otherwise
    // reach the prototype and print a function where a symbol belongs.
    const symbol = Object.hasOwn(CURRENCY_SYMBOLS, currency)
      ? CURRENCY_SYMBOLS[currency]
      : (typeof currency === 'string' && currency.length > 0 ? `${currency} ` : '')
    const units = micros / 1_000_000
    // Above one unit two decimals match how the provider's own console prints
    // money; below it the useful precision is finer than a cent, and rounding a
    // real charge to "0.00" would read as a free call.
    const text = units >= 1 || units === 0
      ? units.toFixed(2)
      : units.toFixed(6).replace(/0+$/, '')
    return `${symbol}${text}`
  }

  /**
   * Format a token count compactly.
   * @param {unknown} value
   * @returns {string}
   */
  function formatTokens(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0'
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
    if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`
    return String(Math.round(value))
  }

  /**
   * Pick the amount to show for one aggregate in the configured currency.
   * @param {object|undefined} aggregate
   * @returns {string|undefined}
   */
  function amountTextOf(aggregate) {
    if (aggregate === null || aggregate === undefined) return undefined
    return formatAmount(aggregate.amountMicros, aggregate.amountCurrency)
  }

  /**
   * Whether the meter follows this provider.
   *
   * The host owns the question: it meters the vendors this plugin reads accounts
   * for plus every provider DSH has registered, so a route this build never heard
   * of is still counted. Until a payload answers, an unknown route is asked
   * about — the host's list is the only way that route can ever appear, and a
   * provider that turns out not to be metered is dropped on the next render.
   * @param {string|null|undefined} provider
   * @param {object|null|undefined} meter - the last meter payload, when there is one.
   * @returns {boolean}
   */
  function isMeteredProvider(provider, meter) {
    if (typeof provider !== 'string' || provider.length === 0) return false
    const listed = meter?.metered?.providers
    if (Array.isArray(listed) && listed.length > 0) return listed.includes(provider)
    if (meter === null || meter === undefined) return true
    // A payload from a host that does not report its list: the routes this build
    // ships are the only ones it can vouch for.
    return provider === PROVIDER_ID || provider === DEEPSEEK_PROVIDER_ID || provider === ZHIPU_PROVIDER_ID
  }

  /**
   * The meter read URL for one route and session.
   *
   * The provider travels with the read because the host asks only that vendor's
   * station for a fresh account reading: a read without one costs nothing.
   * @param {string|null|undefined} provider
   * @param {string|null|undefined} sessionId
   * @returns {string}
   */
  function meterUsageUrl(provider, sessionId) {
    const params = []
    if (sessionId !== null && sessionId !== undefined) params.push(`sessionId=${encodeURIComponent(sessionId)}`)
    if (typeof provider === 'string' && provider.length > 0) params.push(`provider=${encodeURIComponent(provider)}`)
    return params.length === 0 ? API.meterUsage : `${API.meterUsage}?${params.join('&')}`
  }

  /**
   * Tokens one aggregate billed: the prompt side (uncached, cache read and
   * write) plus output.
   * @param {object|undefined} summary
   * @returns {number}
   */
  function totalTokensOf(summary) {
    if (summary === null || summary === undefined || summary.calls === 0) return 0
    return (summary.usage?.promptTokens ?? 0) + (summary.usage?.outputTokens ?? 0)
  }

  /** Resource packages of one Zhipu account slice, split by how they are consumed. */
  function zhipuPackages(slice, kind) {
    const packages = slice !== null && slice !== undefined && Array.isArray(slice.packages) ? slice.packages : []
    return packages.filter((entry) => entry !== null && typeof entry === 'object'
      && (kind === 'times' ? entry.kind === 'times' : entry.kind !== 'times'))
  }

  /** Remaining tokens one Zhipu account holds across its token packages. */
  function remainingTokensOf(packages) {
    return packages.reduce((total, entry) => total + (Number.isFinite(entry.remaining) ? entry.remaining : 0), 0)
  }

  /** The two quota windows the indicator summarises, in display order. */
  function summaryWindows(quota) {
    const windows = quota !== null && quota !== undefined && Array.isArray(quota.windows) ? quota.windows : []
    return windows.filter((window) => window.id === 'primary' || window.id === 'secondary')
  }

  /**
   * Headline text of the unified indicator for one provider view.
   *
   * Pure so the provider-switch behavior is testable without rendering: the
   * same inputs always produce the same one-line summary.
   * @param {object} input
   * @param {string|null} input.provider - current session provider id.
   * @param {object|null} input.meter - `/meter/usage` payload.
   * @param {object|null} input.quota - `/balance` payload for the subscription.
   * @param {(key: string) => string} input.t
   * @returns {{provider: string, text: string}|null} null when nothing should render.
   */
  function indicatorHeadline({ provider, meter, quota, t }) {
    if (!isMeteredProvider(provider, meter)) return null
    if (provider === PROVIDER_ID) {
      const parts = summaryWindows(quota).map((window) => `${windowShortLabel(t, window)} ${window.remainingPercent}%`)
      return { provider, text: parts.length > 0 ? `OpenAI ${parts.join(' · ')}` : 'OpenAI …' }
    }
    if (provider === ZHIPU_PROVIDER_ID) {
      if (meter === null || meter === undefined) return null
      const remaining = remainingTokensOf(zhipuPackages(meter.zhipu, 'tokens'))
      const used = totalTokensOf(meter.usage?.today)
      const pieces = []
      if (remaining > 0) pieces.push(`${t('meterRemaining')} ${formatTokens(remaining)}`)
      if (used > 0) pieces.push(`${t('meterToday')} ${formatTokens(used)}`)
      // An account with no tokens left and nothing spent has nothing to say; the
      // reason it has no reading lives in the card.
      if (pieces.length === 0) return null
      return { provider, text: `GLM ${pieces.join(' · ')}` }
    }
    if (provider === DEEPSEEK_PROVIDER_ID) {
      // Without a reading there is nothing to say about a DeepSeek account, and a
      // placeholder would occupy the sidebar seat while saying nothing.
      if (meter === null || meter === undefined) return null
      const balance = meter.deepseek
      const hidden = balance !== undefined && balance.hidden === true
      const primary = hidden ? undefined : balance?.primary
      const spent = amountTextOf(meter?.usage?.today)
      const pieces = []
      if (primary !== undefined) pieces.push(formatAmount(Math.round(primary.total * 1_000_000), primary.currency))
      if (spent !== undefined) pieces.push(`${t('meterToday')} ${spent}`)
      // An account whose balance cannot be read and that has spent nothing has
      // nothing to show either; the reason lives in the tooltip.
      if (pieces.length === 0) return null
      return { provider, text: `DeepSeek ${pieces.join(' · ')}` }
    }
    // A route the host meters but this build has no account reading for — a vendor
    // another plugin added. Tokens are everything the meter can honestly report
    // about it, and they are reported under that route's own name.
    if (meter === null || meter === undefined) return null
    const today = totalTokensOf(meter.usage?.today)
    const used = today > 0 ? today : totalTokensOf(meter.usage?.month)
    if (used === 0) return null
    return { provider, text: `${provider} ${t('meterToday')} ${formatTokens(used)}` }
  }

  /**
   * Current viewport size. A window that reports no finite size yields 0x0,
   * which {@link clampFloatingPanel} resolves to the top-left margin.
   * @returns {{width:number,height:number}}
   */
  function viewportSize() {
    if (typeof window === 'undefined') return { width: 0, height: 0 }
    return {
      width: Number.isFinite(window.innerWidth) ? window.innerWidth : 0,
      height: Number.isFinite(window.innerHeight) ? window.innerHeight : 0,
    }
  }

  /**
   * Attach one floating element to the document body, where no slot ancestor can
   * clip it. Without a module table entry for `react-dom`, or without a document
   * to attach to, the element stays where it was rendered.
   * @param {object} element - React element to attach.
   * @returns {object} the portal, or the element itself.
   */
  function floatFree(element) {
    if (createPortal === null || typeof document === 'undefined' || document.body === null) return element
    return createPortal(element, document.body)
  }

  /**
   * Keep a floating panel fully inside the viewport, leaving a margin at every
   * edge. A panel wider or taller than the viewport pins to the top-left margin
   * rather than flipping to the opposite edge.
   * @param {{x:number,y:number,width:number,height:number}} panel - requested panel box in viewport coordinates.
   * @param {{width:number,height:number}} viewport - current viewport size.
   * @returns {{x:number,y:number,width:number,height:number}} the clamped box.
   */
  function clampFloatingPanel(panel, viewport) {
    return {
      x: Math.min(Math.max(panel.x, FLOAT_MARGIN_PX), Math.max(FLOAT_MARGIN_PX, viewport.width - panel.width - FLOAT_MARGIN_PX)),
      y: Math.min(Math.max(panel.y, FLOAT_MARGIN_PX), Math.max(FLOAT_MARGIN_PX, viewport.height - panel.height - FLOAT_MARGIN_PX)),
      width: panel.width,
      height: panel.height,
    }
  }

  /** Whether two boxes overlap after reserving a gap around the obstacle. */
  function panelOverlaps(panel, obstacle) {
    return panel.x < obstacle.x + obstacle.width + COLLISION_GAP_PX
      && panel.x + panel.width + COLLISION_GAP_PX > obstacle.x
      && panel.y < obstacle.y + obstacle.height + COLLISION_GAP_PX
      && panel.y + panel.height + COLLISION_GAP_PX > obstacle.y
  }

  /**
   * Move a panel to the nearest candidate that does not cover any occupied UI.
   * Candidates sit immediately above, below, left, or right of each obstacle;
   * resolving repeatedly lets a panel step around a cluster of controls.
   */
  function avoidPanelCollisions(panel, obstacles, viewport) {
    const origin = clampFloatingPanel(panel, viewport)
    if (!obstacles.some((obstacle) => panelOverlaps(origin, obstacle))) return origin
    const candidates = [origin]
    for (const obstacle of obstacles) {
      candidates.push(
        { ...origin, x: obstacle.x - origin.width - COLLISION_GAP_PX },
        { ...origin, x: obstacle.x + obstacle.width + COLLISION_GAP_PX },
        { ...origin, y: obstacle.y - origin.height - COLLISION_GAP_PX },
        { ...origin, y: obstacle.y + obstacle.height + COLLISION_GAP_PX },
      )
    }
    return candidates
      .map((candidate) => clampFloatingPanel(candidate, viewport))
      .filter((candidate) => !obstacles.some((obstacle) => panelOverlaps(candidate, obstacle)))
      .sort((left, right) => {
        const leftDistance = (left.x - origin.x) ** 2 + (left.y - origin.y) ** 2
        const rightDistance = (right.x - origin.x) ** 2 + (right.y - origin.y) ** 2
        return leftDistance - rightDistance
      })[0] || origin
  }

  /** Visible interactive boxes, excluding the floating indicator itself. */
  function occupiedUiBoxes(owner) {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return []
    const boxes = []
    for (const node of document.querySelectorAll(COLLISION_SELECTOR)) {
      if (node === owner || (owner && typeof owner.contains === 'function' && owner.contains(node))) continue
      if (typeof node.getBoundingClientRect !== 'function') continue
      const rect = node.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) continue
      boxes.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height })
    }
    return boxes
  }

  /** Resolve one panel box against the live viewport and visible controls. */
  function settlePanel(panel, owner) {
    return avoidPanelCollisions(panel, occupiedUiBoxes(owner), viewportSize())
  }

  /**
   * Whether two panel boxes place and size the panel identically. Callers use
   * it to keep the previous box object when a re-clamp changed nothing, so the
   * state update cannot re-trigger the effect that produced it.
   * @param {{x:number,y:number,width:number,height:number}} left
   * @param {{x:number,y:number,width:number,height:number}} right
   * @returns {boolean}
   */
  function samePanel(left, right) {
    return left.x === right.x
      && left.y === right.y
      && left.width === right.width
      && left.height === right.height
  }

  /**
   * Rendered size of one panel node, or null when the box is unavailable or
   * empty (a node that has not been committed yet).
   * @param {object|null|undefined} node - panel DOM node.
   * @returns {{width:number,height:number}|null}
   */
  function nodeSize(node) {
    if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return null
    const rect = node.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 ? { width: rect.width, height: rect.height } : null
  }

  /**
   * The flex container one footer action is laid out in. A slot renders a
   * `display: contents` wrapper, so the registered element is really laid out
   * by the nearest ancestor that creates a flex box.
   * @param {object|null|undefined} node - the indicator's DOM node.
   * @returns {object|null} the flex container, or null when none is reachable.
   */
  function flexSeatOf(node) {
    if (node === null || node === undefined) return null
    if (typeof window.getComputedStyle !== 'function') return null
    let seat = node.parentElement
    for (let depth = 0; depth < 4 && seat !== null && seat !== undefined; depth += 1) {
      const display = window.getComputedStyle(seat).display
      if (display === 'flex' || display === 'inline-flex') return seat
      if (display !== 'contents') return null
      seat = seat.parentElement
    }
    return null
  }

  /**
   * Parse one persisted panel box. Anything a drag never wrote — absent,
   * truncated, or non-finite — reads as "no stored position".
   * @param {string|null|undefined} raw - raw storage value.
   * @returns {{x:number,y:number,width:number,height:number}|null}
   */
  function parseStoredPanel(raw) {
    if (typeof raw !== 'string' || raw.length === 0) return null
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    if (parsed === null || typeof parsed !== 'object') return null
    const values = [parsed.x, parsed.y, parsed.width, parsed.height]
    if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return null
    if (parsed.width <= 0 || parsed.height <= 0) return null
    return { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height }
  }

  /**
   * Browser storage, or null where the page denies it.
   * @returns {Storage|null}
   */
  function panelStorage() {
    try {
      if (typeof window === 'undefined' || window.localStorage === undefined) return null
      return window.localStorage
    } catch {
      // Touching localStorage itself throws on a blocked origin; the drag still
      // works for this page, only the remembered position is lost.
      return null
    }
  }

  /**
   * Remembered panel box, already clamped into the current viewport.
   * @returns {{x:number,y:number,width:number,height:number}|null}
   */
  function readStoredPanel() {
    const storage = panelStorage()
    if (storage === null) return null
    const stored = parseStoredPanel(storage.getItem(PANEL_STORE_KEY))
    return stored === null ? null : clampFloatingPanel(stored, viewportSize())
  }

  /**
   * Persist a panel box; a null panel clears the stored position.
   * @param {{x:number,y:number,width:number,height:number}} panel
   * @returns {void}
   */
  function writeStoredPanel(panel) {
    const storage = panelStorage()
    if (storage === null) return
    try {
      storage.setItem(PANEL_STORE_KEY, JSON.stringify(panel))
    } catch {
      // Quota or a blocked origin: the panel stays where it was dragged.
    }
  }

  /**
   * Drop the stored position so the next page load docks the panel again.
   * @returns {void}
   */
  function clearStoredPanel() {
    const storage = panelStorage()
    if (storage === null) return
    try {
      storage.removeItem(PANEL_STORE_KEY)
    } catch {
      // A key that cannot be removed only costs a stale position, never a crash.
    }
  }

  /**
   * Sidebar balance indicator. It stays in the sidebar foot until the user
   * drags it; the drag detaches it into a viewport-fixed panel at the dragged
   * position, which is stored for the next page load and re-clamped whenever
   * the window shrinks. A double click docks it again, and arrow keys nudge a
   * focused indicator (hold Shift for single pixels).
   * @param {object} props - owner props plus the inject face.
   * @returns {object|null} the indicator, or null while another provider is selected.
   */
  function BalanceSidebarIndicator(props) {
    const { sessionsService, modelDirectories, getLocale } = props
    const t = useT(getLocale)
    const currentProvider = useCurrentProvider(sessionsService, modelDirectories)
    const sessionId = useCurrentSessionId(sessionsService)
    const [meter, setMeter] = useState(null)
    const [quota, setQuota] = useState(null)
    const [panel, setPanel] = useState(readStoredPanel)
    const [dragging, setDragging] = useState(false)
    const nodeRef = useRef(null)
    const dragRef = useRef(null)
    // One indicator follows the model switch. Every poll carries the provider
    // it was started for, and a response whose provider is no longer current is
    // dropped: a slow DeepSeek answer can never repaint an OpenAI session.
    const generationRef = useRef(0)
    // The route the host answered that it does not meter, so the poll can stop
    // asking instead of repeating a request that will always come back empty.
    const unmeteredRef = useRef(null)
    const floating = panel !== null
    const headline = indicatorHeadline({ provider: currentProvider, meter, quota, t })
    // A phone reaching this harness remotely gets an icon and opens the numbers
    // with a click; a desktop window has room for the numbers themselves, so it
    // keeps showing the balance (or quota) and the spend.
    const [narrow, setNarrow] = useState(() => viewportSize().width < NARROW_VIEWPORT_PX)
    const [open, setOpen] = useState(false)
    // Bumped by every interaction with the card, which restarts its countdown.
    const [activity, setActivity] = useState(0)
    const details = indicatorDetails({ provider: currentProvider, meter, quota, t })
    const summary = headline === null ? '' : headline.text

    useEffect(() => {
      if (!isMeteredProvider(currentProvider)) {
        generationRef.current += 1
        setMeter(null)
        setQuota(null)
        return undefined
      }
      const generation = generationRef.current + 1
      generationRef.current = generation
      const metered = isMeteredProvider(currentProvider)
      const cadence = metered ? METER_POLL_MS : BALANCE_POLL_MS
      let cancelled = false
      async function load() {
        // The host may already have answered that this route is not metered:
        // there is nothing left to ask it for.
        if (unmeteredRef.current === currentProvider) return
        // The session window is keyed by the session, so the poll reloads when
        // it changes; a provider-only dependency would keep the old totals.
        const url = meterUsageUrl(currentProvider, sessionId)
        let nextMeter
        let nextQuota
        try {
          const payload = await getJson(url)
          nextMeter = payload.data
        } catch {
          // A failed read keeps the last good view: a transient error must not
          // blank a number the user is reading, and flipping to a placeholder
          // would make the sidebar flicker on every poll.
          nextMeter = undefined
        }
        // The meter already answers with the subscription quota, so one poll
        // covers both accounts. The separate read stays as the fallback for a
        // host whose meter route is not mounted yet.
        nextQuota = nextMeter?.openaiQuota
        if (nextQuota === undefined && metered === false) {
          try {
            const payload = await getJson(`${API.balance}?provider=${encodeURIComponent(PROVIDER_ID)}`)
            nextQuota = payload.data
          } catch {
            nextQuota = null
          }
        }
        if (cancelled || generationRef.current !== generation) return
        if (nextMeter !== undefined && isMeteredProvider(currentProvider, nextMeter) === false) {
          // The host answered that it does not meter this route: stop asking and
          // stop showing whatever the previous route left behind.
          unmeteredRef.current = currentProvider
          generationRef.current += 1
          setMeter(null)
          setQuota(null)
          return
        }
        if (nextMeter !== undefined) setMeter(nextMeter)
        if (metered === false && nextQuota !== undefined) setQuota(nextQuota)
      }
      load()
      const timer = setInterval(() => { void load() }, cadence)
      return () => {
        cancelled = true
        clearInterval(timer)
      }
    }, [currentProvider, sessionId, sessionsService])

    // Persist once the panel settles, so a drag writes after the last move
    // instead of on every pointer event.
    useEffect(() => {
      if (panel === null) {
        clearStoredPanel()
        return undefined
      }
      const timer = setTimeout(() => { writeStoredPanel(panel) }, 200)
      return () => { clearTimeout(timer) }
    }, [panel])

    // The panel sizes to its own text, so the box measured while docked is the
    // sidebar's, not the floating panel's. Re-measure whenever it starts
    // floating or its text changes, and clamp against that, or it would grow
    // past an edge.
    useEffect(() => {
      if (floating === false) return undefined
      const size = nodeSize(nodeRef.current)
      if (size === null) return undefined
      setPanel((current) => {
        if (current === null) return null
        const next = settlePanel({ x: current.x, y: current.y, ...size }, nodeRef.current)
        return samePanel(next, current) ? current : next
      })
    }, [floating, summary])

    // The home seat is one nowrap flex row that every footer action shares —
    // dsh-cost-meter is a regular occupant of it. Two information widgets
    // cannot share that row without one of them being squeezed, so while the
    // indicator shows its text it may start a line of its own above the others.
    // The wrap belongs to the seat, so it is restored on the way out. An icon
    // needs no line of its own, so a narrow viewport leaves the seat exactly as
    // the other occupants laid it out.
    useEffect(() => {
      if (floating === true || narrow === true || headline === null) return undefined
      const seat = flexSeatOf(nodeRef.current)
      if (seat === null) return undefined
      const previousWrap = seat.style.flexWrap
      seat.style.flexWrap = 'wrap'
      return () => { seat.style.flexWrap = previousWrap }
    }, [floating, narrow, headline === null])

    // A shrinking window must not strand the panel outside the viewport, and it
    // decides which of the two renderings the indicator uses.
    useEffect(() => {
      const onResize = () => {
        setNarrow(viewportSize().width < NARROW_VIEWPORT_PX)
        const size = nodeSize(nodeRef.current)
        setPanel((current) => {
          if (current === null) return null
          const next = settlePanel({ x: current.x, y: current.y, ...(size || current) }, nodeRef.current)
          return samePanel(next, current) ? current : next
        })
      }
      window.addEventListener('resize', onResize)
      return () => { window.removeEventListener('resize', onResize) }
    }, [])

    // The card retracts on its own. It is a reading taken at one moment, and the
    // account behind it moves on: left open on a phone it covers the
    // conversation, and it keeps showing the model the user has already left.
    useEffect(() => {
      if (open === false) return undefined
      const timer = setTimeout(() => { setOpen(false) }, AUTO_COLLAPSE_MS)
      return () => { clearTimeout(timer) }
    }, [open, activity])

    // A press anywhere outside the indicator and its card retracts it. Capture
    // phase, so a press that a handler downstream swallows still counts.
    useEffect(() => {
      if (open === false) return undefined
      if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
      const onPress = (event) => {
        const target = event.target
        const anchor = nodeRef.current
        if (anchor !== null && anchor !== undefined && typeof anchor.contains === 'function' && anchor.contains(target) === true) return
        if (target !== null && target !== undefined && typeof target.closest === 'function' && target.closest('[data-details="meter"]') !== null) return
        setOpen(false)
      }
      document.addEventListener('pointerdown', onPress, true)
      return () => { document.removeEventListener('pointerdown', onPress, true) }
    }, [open])

    // Switching model switches the account the numbers belong to, so an open
    // card must not keep showing the previous one.
    useEffect(() => { setOpen(false) }, [currentProvider])

    if (headline === null) return null

    /** Measure the rendered node into viewport coordinates. */
    function boxOf(node) {
      const rect = node.getBoundingClientRect()
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    }

    function onPointerDown(event) {
      if (typeof event.button === 'number' && event.button !== 0) return
      const node = event.currentTarget
      if (node === null || typeof node.getBoundingClientRect !== 'function') return
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        box: boxOf(node),
        moved: false,
      }
      if (typeof node.setPointerCapture === 'function') {
        try {
          node.setPointerCapture(event.pointerId)
        } catch {
          // Capture is an enhancement: the drag also tracks without it.
        }
      }
    }

    function onPointerMove(event) {
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) return
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      if (drag.moved === false && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return
      if (drag.moved === false) {
        drag.moved = true
        setDragging(true)
      }
      event.preventDefault()
      const size = nodeSize(event.currentTarget) || { width: drag.box.width, height: drag.box.height }
      setPanel(clampFloatingPanel({
        x: drag.box.x + dx,
        y: drag.box.y + dy,
        ...size,
      }, viewportSize()))
    }

    function endDrag(event) {
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) return
      dragRef.current = null
      if (drag.moved === true) {
        setDragging(false)
        setPanel((current) => current === null ? null : settlePanel(current, nodeRef.current))
      }
    }

    function onKeyDown(event) {
      if (event.key === 'Escape' && open === true) {
        setOpen(false)
        return
      }
      const step = event.shiftKey === true ? 1 : 16
      const delta = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      }[event.key]
      if (delta === undefined) return
      const node = event.currentTarget
      const box = panel === null && node !== null && typeof node.getBoundingClientRect === 'function'
        ? boxOf(node)
        : panel
      if (box === null) return
      event.preventDefault()
      setPanel(clampFloatingPanel({
        x: box.x + delta[0],
        y: box.y + delta[1],
        width: box.width,
        height: box.height,
      }, viewportSize()))
    }

    function onDoubleClick() {
      dragRef.current = null
      setDragging(false)
      setPanel(null)
    }

    /** Reveal or hide the numbers, unless the press turned into a drag. */
    function onClick() {
      if (dragRef.current !== null && dragRef.current.moved === true) return
      setOpen((current) => !current)
    }

    /**
     * Where the open card sits: just above the icon, sized to the viewport.
     *
     * The card wraps rather than clips. On a phone-width or remote sidebar the
     * numbers cannot share the icon's line, and a nowrap line was exactly what
     * overflowed the screen.
     * @returns {object}
     */
    function detailsStyle() {
      const margin = FLOAT_MARGIN_PX
      const minWidth = 160
      const maxWidth = 320
      const viewport = viewportSize()
      const node = nodeRef.current
      const box = node !== null && node !== undefined && typeof node.getBoundingClientRect === 'function' ? boxOf(node) : null
      const width = Math.max(minWidth, Math.min(maxWidth, viewport.width - margin * 2))
      return {
        position: 'fixed',
        left: box === null
          ? margin
          : Math.min(Math.max(box.x, margin), Math.max(margin, viewport.width - width - margin)),
        bottom: box === null ? margin : Math.max(margin, viewport.height - box.y + margin),
        width,
        maxHeight: Math.max(120, viewport.height - margin * 2),
        overflowY: 'auto',
        whiteSpace: 'normal',
        wordBreak: 'break-word',
        textAlign: 'left',
        zIndex: FLOAT_Z_INDEX,
        background: '#111827',
        color: '#f9fafb',
        border: '1px solid #374151',
        borderRadius: 10,
        boxShadow: '0 6px 18px rgba(0, 0, 0, 0.35)',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        fontSize: 12,
      }
    }

    const placement = panel === null
      ? (narrow
          ? {
              // An icon is small enough to share the footer row: no line of its
              // own, and nothing to clip.
              flex: '0 0 auto',
              order: -1,
              boxSizing: 'border-box',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 4,
            }
          : {
              // The footer-action seat is one flex row shared with every other
              // registered action, and each occupant owns its button geometry.
              // The numbers need a whole line of that (now wrapping) row, sorted
              // ahead of the other occupants, and the box clips its own overflow
              // so it can never cover a neighbour.
              flex: '1 1 100%',
              order: -1,
              minWidth: 0,
              boxSizing: 'border-box',
              textAlign: 'left',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            })
      : {
          position: 'fixed',
          left: panel.x,
          top: panel.y,
          // Detached, the box sizes to what it holds; `maxWidth` only binds on a
          // viewport narrower than that, where trimming is the least-bad reading.
          whiteSpace: 'nowrap',
          maxWidth: Math.max(FLOAT_MARGIN_PX * 2, viewportSize().width - FLOAT_MARGIN_PX * 2),
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          ...(narrow
            ? { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 4 }
            : {}),
          zIndex: FLOAT_Z_INDEX,
          boxShadow: '0 6px 18px rgba(0, 0, 0, 0.35)',
        }
    const cardElement = h('div', {
      key: 'indicator-details',
      'data-details': 'meter',
      role: 'group',
      'aria-label': t('meterTitle'),
      style: detailsStyle(),
      onClick: (event) => { event.stopPropagation() },
      onPointerEnter: () => { setActivity((count) => count + 1) },
      onPointerDown: () => { setActivity((count) => count + 1) },
    }, [
      h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } }, [
        h('strong', { key: 'title' }, t('meterTitle')),
        h('span', {
          key: 'close',
          role: 'button',
          tabIndex: 0,
          'aria-label': t('panelClose'),
          style: { cursor: 'pointer', padding: '0 4px', fontSize: 14, lineHeight: 1 },
          onClick: (event) => { event.stopPropagation(); setOpen(false) },
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            setOpen(false)
          },
        }, '×'),
      ]),
      ...details.map((line, index) => h('div', { key: `line-${index}` }, line)),
    ])
    const card = open === false ? null : floatFree(cardElement)
    const indicator = h('button', {
      key: 'icon',
      type: 'button',
      ref: nodeRef,
      style: {
        ...s.button,
        ...placement,
        cursor: dragging === true ? 'grabbing' : 'grab',
        touchAction: 'none',
        userSelect: 'none',
      },
      title: `${indicatorTooltip({ provider: currentProvider, meter, quota, t })} · ${t('panelClickHint')} · ${t('panelDragHint')}`,
      'aria-label': t('meterTitle'),
      'aria-expanded': open,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick,
      onKeyDown,
      onClick,
    }, narrow
      ? h('svg', {
          key: 'glyph',
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          'aria-hidden': true,
          focusable: false,
        }, [
          h('rect', { key: 'bar-1', x: 2, y: 9, width: 3, height: 5, rx: 1, fill: 'currentColor' }),
          h('rect', { key: 'bar-2', x: 6.5, y: 5, width: 3, height: 9, rx: 1, fill: 'currentColor' }),
          h('rect', { key: 'bar-3', x: 11, y: 2, width: 3, height: 12, rx: 1, fill: 'currentColor' }),
        ])
      : summary)
    return h('div', { key: 'indicator', style: { display: 'contents' } }, [
      // Detached, the numbers leave the seat entirely: the sidebar's own width
      // and clipping are what stopped them from floating free in the first place.
      floating ? floatFree(indicator) : indicator,
      card,
    ])
  }

  /**
   * The indicator's details, one fact per line.
   *
   * The card behind the icon renders these as lines and the hover tooltip joins
   * them, so the two readings can never disagree.
   *
   * Every period the meter keeps is stated here — session, today, month — since
   * a single line can only carry two of them.
   * @param {object} input - same inputs as {@link indicatorHeadline}.
   * @returns {string[]}
   */
  function indicatorDetails({ provider, meter, quota, t }) {
    if (provider === PROVIDER_ID) {
      const detail = summaryWindows(quota)
        .map((window) => `${windowLabel(t, window)} ${window.remainingPercent}%`)
        .join(' / ')
      return ['OpenAI (ChatGPT OAuth)', detail, ...tokenLines(meter, t)].filter(isFilled)
    }
    if (provider === ZHIPU_PROVIDER_ID) {
      const slice = meter?.zhipu
      const plan = slice?.plan
      const windows = plan?.applicable === true && Array.isArray(plan.windows) && plan.windows.length > 0
        ? plan.windows.map((window) => `${quotaWindowLabel(t, window)} ${window.remainingPercent}%`).join(' / ')
        : undefined
      // The station's own refusal text is data from the vendor, so an account
      // without a coding plan reads as exactly that instead of as an empty quota.
      const planLine = plan?.applicable === false ? plan.reason || t('meterNoPlan') : windows
      const cash = slice?.balance
      const money = (micros) => (typeof micros === 'number' && Number.isFinite(micros)
        ? formatAmount(Math.round(micros * 1_000_000), cash?.currency) ?? ''
        : undefined)
      const available = money(cash?.available)
      // A zero spend is the normal state of an untouched account, not a fact
      // worth a line.
      const spent = typeof cash?.spent === 'number' && Number.isFinite(cash.spent) && cash.spent > 0 ? money(cash.spent) : undefined
      const until = (entry) => (entry.expiresAt === undefined || entry.expiresAt === null
        ? undefined
        : `${t('meterUntil')} ${String(entry.expiresAt).slice(0, 10)}`)
      // One package per line, in the order the station lists them, with the
      // model scope and the expiry the station reports for each.
      const packageLine = (entry) => [
        `${entry.name} ${entry.kind === 'times' ? `${entry.remaining} ${t('meterUses')}` : formatTokens(entry.remaining)}`,
        entry.scope === undefined ? undefined : `(${entry.scope})`,
        until(entry),
      ].filter(isFilled).join(' · ')
      const packages = slice !== undefined && Array.isArray(slice.packages) ? slice.packages : []
      return [
        'GLM (Z.AI)',
        planLine,
        available === undefined ? undefined : `${t('meterBalance')} ${available}`,
        spent === undefined ? undefined : `${t('meterSpent')} ${spent}`,
        ...packages.map(packageLine),
        slice !== undefined && Array.isArray(slice.errors) && slice.errors.length > 0
          ? `${t('meterReadingUnavailable')} (${slice.errors.join(', ')})`
          : undefined,
        ...tokenLines(meter, t),
      ].filter(isFilled)
    }
    if (provider === DEEPSEEK_PROVIDER_ID) {
      const balance = meter?.deepseek
      const account = meter?.account?.kind
      const pricing = meter?.pricing
      const balanceUnavailable = balance !== undefined && balance.status !== 'ok' && balance.status !== 'idle'
      return [
        'DeepSeek',
        balance?.primary === undefined ? undefined : `${balance.primary.currency} ${balance.primary.total}`,
        balanceUnavailable ? balance.message || t('meterUnavailable') : undefined,
        account === 'enterprise' ? t('meterAccountEnterprise') : account === 'personal' ? t('meterAccountPersonal') : t('meterAccountUnknown'),
        ...tokenLines(meter, t),
        amountTextOf(meter?.usage?.today) === undefined ? undefined : `${t('meterToday')} ${amountTextOf(meter?.usage?.today)}`,
        amountTextOf(meter?.usage?.month) === undefined ? undefined : `${t('meterMonth')} ${amountTextOf(meter?.usage?.month)}`,
        priceSourceLine(pricing, t),
        unpricedModelsLine(pricing, provider, t),
        priceRefreshLine(pricing, t),
      ].filter(isFilled)
    }
    // A route the host meters without an account reading of its own: the card
    // states the route and its token totals, and claims nothing about money.
    return [provider, ...tokenLines(meter, t), unpricedModelsLine(meter?.pricing, provider, t)].filter(isFilled)
  }

  /**
   * The same facts as one line, for the hover tooltip a pointer device gets.
   * @param {object} input - same inputs as {@link indicatorHeadline}.
   * @returns {string}
   */
  function indicatorTooltip(input) {
    return indicatorDetails(input).join(' · ')
  }

  /**
   * Token totals for the three periods the ledger keeps.
   * @param {object|null} meter
   * @param {(key: string) => string} t
   * @returns {string[]}
   */
  function tokenLines(meter, t) {
    const periods = [[t('meterSession'), 'session'], [t('meterToday'), 'today'], [t('meterMonth'), 'month']]
    return periods
      .map(([label, key]) => {
        const summary = meter?.usage?.[key]
        if (summary === undefined || summary.calls === 0) return undefined
        return `${label} ${formatTokens(summary.usage?.promptTokens ?? 0)} → ${formatTokens(summary.usage?.outputTokens ?? 0)}`
      })
      .filter(isFilled)
  }

  /**
   * The models of one route this deployment has no rate for, named so they can be
   * added.
   *
   * Only a missing rate is listed. A vendor that publishes no price table at all
   * is not a gap in anything, so it never appears here, and the list is filtered
   * to the route the card describes: another vendor's missing rate is not this
   * one's business.
   * @param {object|undefined} pricing - meter view `pricing` slice.
   * @param {string} provider
   * @param {(key: string) => string} t
   * @returns {string|undefined}
   */
  function unpricedModelsLine(pricing, provider, t) {
    const models = pricing?.unpricedModels
    if (!Array.isArray(models)) return undefined
    const named = models
      .filter((entry) => entry !== null && typeof entry === 'object' && entry.provider === provider && typeof entry.model === 'string')
      .map((entry) => `${entry.model} ×${Number.isFinite(entry.calls) ? entry.calls : 1}`)
    if (named.length === 0) return undefined
    return `${t('meterNoPrice')}: ${named.join(' · ')}`
  }

  /**
   * Why the price table could not be refreshed, when it could not.
   *
   * A page that stopped parsing is invisible otherwise: the meter keeps pricing
   * with the table it has, and nobody learns that shipped models stay unpriced.
   * @param {object|undefined} pricing - meter view `pricing` slice.
   * @param {(key: string) => string} t
   * @returns {string|undefined}
   */
  function priceRefreshLine(pricing, t) {
    const refresh = pricing?.refresh
    if (refresh === null || refresh === undefined) return undefined
    if (typeof refresh.lastError !== 'string' || refresh.lastError.length === 0) return undefined
    return `${t('meterPriceRefreshFailed')}: ${refresh.lastError}`
  }

  /**
   * Which price table a shown cost came from.
   *
   * A configured agreement is reported as in force only when it really is in
   * force for this account; otherwise the public snapshot is named, so the user
   * is never told they are billed at a contract rate they are not.
   * @param {object|undefined} pricing - meter view `pricing` slice.
   * @param {(key: string) => string} t
   * @returns {string|undefined}
   */
  function priceSourceLine(pricing, t) {
    if (pricing === undefined || pricing === null) return undefined
    if (pricing.contractual?.active === true) {
      const label = typeof pricing.contractual.label === 'string' ? ` ${pricing.contractual.label}` : ''
      return `${t('meterPriceSource')}: ${t('meterContractPrice')}${label} ${t('meterEstimated')}`.trim()
    }
    const retrieved = pricing.public?.retrievedAt
    return `${t('meterPriceSource')}: ${t('meterPublicPrice')}${typeof retrieved === 'string' ? ` ${retrieved}` : ''} ${t('meterEstimated')}`.trim()
  }

  /** Whether a composed tooltip fragment carries a fact. */
  function isFilled(part) {
    return typeof part === 'string' && part.length > 0
  }

  /**
   * One-line session usage for the composer dock.
   *
   * OpenAI sessions show tokens and cache behaviour without money, because a
   * ChatGPT subscription has no per-token cash settlement. DeepSeek sessions add
   * the locally estimated cost of exactly those tokens.
   * @param {object} input
   * @param {string|null} input.provider
   * @param {object|null} input.meter
   * @param {(key: string) => string} input.t
   * @returns {{text: string, detail: string}|null}
   */
  function sessionUsageLine({ provider, meter, t }) {
    if (!isMeteredProvider(provider, meter)) return null
    const session = meter?.usage?.session
    if (session === undefined || session === null || session.calls === 0) return null
    const usage = session.usage ?? {}
    // The route's own name is the honest label for a vendor this build does not
    // know: calling it DeepSeek would attribute another vendor's tokens to it.
    const label = provider === PROVIDER_ID
      ? 'OpenAI'
      : provider === ZHIPU_PROVIDER_ID ? 'GLM' : provider === DEEPSEEK_PROVIDER_ID ? 'DeepSeek' : provider
    const parts = [`${t('meterSession')} ${formatTokens(usage.promptTokens ?? 0)} → ${formatTokens(usage.outputTokens ?? 0)}`]
    const ratio = session.cacheHitRatio
    if (typeof ratio === 'number' && Number.isFinite(ratio)) {
      const percent = ratio * 100
      parts.push(`${t('meterCacheHit')} ${percent === 0 || percent >= 99.5 ? percent.toFixed(0) : percent.toFixed(1)}%`)
    }
    const cost = provider === DEEPSEEK_PROVIDER_ID ? amountTextOf(session) : undefined
    if (cost !== undefined) parts.push(`${cost} ${t('meterEstimated')}`)
    return { text: `${label} · ${parts.join(' · ')}`, detail: `${label} ${t('meterTitle')}` }
  }

  /**
   * Session usage below the composer card. It shares the sidebar's data source,
   * so the two views can never disagree about the same session.
   * @param {object} props - owner props plus the inject face.
   * @returns {object|null}
   */
  function SessionUsageDock(props) {
    const { sessionsService, modelDirectories, getLocale } = props
    const t = useT(getLocale)
    const currentProvider = useCurrentProvider(sessionsService, modelDirectories)
    const sessionId = useCurrentSessionId(sessionsService)
    const [meter, setMeter] = useState(null)
    const generationRef = useRef(0)
    // The route the host answered that it does not meter, so the poll can stop
    // asking and the line can stay hidden.
    const unmeteredRef = useRef(null)

    useEffect(() => {
      if (!isMeteredProvider(currentProvider)) {
        generationRef.current += 1
        setMeter(null)
        return undefined
      }
      const generation = generationRef.current + 1
      generationRef.current = generation
      let cancelled = false
      async function load() {
        if (unmeteredRef.current === currentProvider) return
        // The session, not just the provider: two sessions can share a provider,
        // and reloading only on the provider would keep the old totals visible.
        if (!sessionId) return
        try {
          const payload = await getJson(meterUsageUrl(currentProvider, sessionId))
          if (cancelled || generationRef.current !== generation) return
          if (isMeteredProvider(currentProvider, payload.data) === false) {
            unmeteredRef.current = currentProvider
            generationRef.current += 1
            setMeter(null)
            return
          }
          setMeter(payload.data)
        } catch {
          // A missing meter leaves the line hidden rather than showing stale money.
        }
      }
      load()
      const timer = setInterval(() => { void load() }, METER_POLL_MS)
      return () => {
        cancelled = true
        clearInterval(timer)
      }
    }, [currentProvider, sessionId, sessionsService])

    const line = sessionUsageLine({ provider: currentProvider, meter, t })
    if (line === null) return null
    return h('div', { style: s.sessionDock, title: line.detail }, line.text)
  }

  const inject = ['slots', 'sessions', 'modelDirectories']

  function baseInject(ctx) {
    return () => ({
      sessionsService: ctx.sessions,
      modelDirectories: ctx.modelDirectories,
      getLocale: () => {
        try {
          return typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        } catch {
          return undefined
        }
      },
    })
  }

  function navLabel(ctx) {
    return () => tNow(baseInject(ctx)().getLocale, 'nav')
  }

  /**
   * Register the four UI surfaces. Registrations are defensive: every
   * slots.inject is contained so an unavailable seat can never throw into the
   * entry audit.
   * @param {object} ctx - browser plugin context.
   * @returns {void}
   */
  function apply(ctx) {
    if (ctx === null || typeof ctx !== 'object' || ctx.slots === undefined || typeof ctx.slots.inject !== 'function') {
      return
    }
    const attempt = (slotName, register) => {
      try {
        ctx.slots.inject(slotName, register)
      } catch {
        // seat unavailable; other surfaces keep working
      }
    }
    attempt('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: SECTION_ID,
      order: 60,
      label: navLabel(ctx),
      inject: baseInject(ctx),
    }, OpenAISubscriptionPage))
    attempt('settings.onboarding', () => ctx.slots.register({
      name: 'settings.onboarding',
      id: ONBOARDING_STEP_ID,
      order: 100,
      label: navLabel(ctx),
      inject: baseInject(ctx),
    }, OpenAISubscriptionOnboardingStep))
    attempt('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: SIDEBAR_ID,
      inject: baseInject(ctx),
    }, BalanceSidebarIndicator))
    attempt('conversation.composer.dock', () => ctx.slots.register({
      name: 'conversation.composer.dock',
      id: SESSION_DOCK_ID,
      order: 6,
      inject: baseInject(ctx),
    }, SessionUsageDock))
  }

  const descriptor = { name: PACKAGE_NAME, inject, apply }
  // Test-only pure surface; non-enumerable so descriptor key scans see the
  // canonical { name, inject, apply } plugin shape.
  Object.defineProperty(descriptor, 'pure', {
    value: {
      COPY,
      translate,
      pickLanguage,
      deriveStatusKind,
      deriveOnboardingDecision,
      clampFloatingPanel,
      avoidPanelCollisions,
      parseStoredPanel,
      formatAmount,
      formatTokens,
      indicatorHeadline,
      indicatorTooltip,
      meterUsageUrl,
      sessionUsageLine,
      AUTO_COLLAPSE_MS,
      // Mounted directly by tests: every slot component nests inside a page
      // component, and a shallow harness cannot drive a nested component's
      // effects, so this one is reachable only through the test surface.
      MeterSettingsPanel,
    },
    enumerable: false,
  })
  module.exports = descriptor
  return module.exports
} })
