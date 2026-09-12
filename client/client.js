/**
 * Browser half of dsh-provider-openai-subscription.
 *
 * Renders four UI surfaces:
 * - a dedicated settings page (slot `settings.section`) where the user
 *   completes the OpenAI/ChatGPT OAuth connection;
 * - a first-run onboarding step (slot `settings.onboarding`) that prompts a
 *   blank session to connect while the plugin is active and signed out;
 * - the settings card (slot `settings.plugin.item`) kept as the original
 *   entry surface;
 * - the sidebar balance indicator (slot `sidebar.footer.action`), which the
 *   user can drag out of the sidebar into a floating panel whose position the
 *   browser remembers.
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

  const PACKAGE_NAME = 'dsh-provider-openai-subscription'
  const PROVIDER_ID = 'openai-subscription'
  const CARD_KEY = 'llm-openai-subscription'
  const SECTION_ID = 'openai-subscription'
  const ONBOARDING_STEP_ID = 'openai-subscription-connect'
  const SIDEBAR_ID = 'dsh-provider-openai-subscription-balance'
  const STATUS_POLL_MS = 60 * 1000
  const BALANCE_POLL_MS = 5 * 60 * 1000
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
      panelDragHint: '拖动可移动位置，双击复位',
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
      panelDragHint: 'Drag to move, double-click to reset',
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

  async function getJson(url, options) {
    const response = await fetch(url, {
      ...(options || {}),
      headers: { accept: 'application/json', ...((options && options.headers) || {}) },
      cache: 'no-store',
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`)
      error.status = response.status
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
  }

  function selectionFromStore(store) {
    if (!store || typeof store.getSnapshot !== 'function') return null
    const snapshot = store.getSnapshot()
    return snapshot && snapshot.current && typeof snapshot.current.provider === 'string'
      ? snapshot.current
      : null
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
          ])
        : null,
    ])
  }

  function OpenAISubscriptionCard(props) {
    const { sessionsService, modelDirectories, getLocale } = props
    const t = useT(getLocale)
    const currentProvider = useCurrentProvider(sessionsService, modelDirectories)
    const flow = useOpenAISubscriptionFlow({ provider: currentProvider })
    return h('div', { style: s.card }, [
      h('h3', { style: s.cardTitle }, t('heading')),
      h(OpenAISubscriptionContent, { flow, currentProvider, t, page: false }),
      h('p', { style: s.note }, t('cardFullPanelHint')),
    ])
  }

  function OpenAISubscriptionPage(props) {
    const { sessionsService, modelDirectories, getLocale } = props
    const t = useT(getLocale)
    const currentProvider = useCurrentProvider(sessionsService, modelDirectories)
    const flow = useOpenAISubscriptionFlow({ provider: currentProvider })
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
    const [balance, setBalance] = useState(null)
    const [panel, setPanel] = useState(readStoredPanel)
    const [dragging, setDragging] = useState(false)
    const nodeRef = useRef(null)
    const dragRef = useRef(null)
    const floating = panel !== null
    const windows = balance && Array.isArray(balance.windows) ? balance.windows : []
    const parts = windows
      .filter((window) => window.id === 'primary' || window.id === 'secondary')
      .map((window) => `${windowShortLabel(t, window)} ${window.remainingPercent}%`)
    const summary = parts.length > 0 ? `OpenAI ${parts.join(' · ')}` : 'OpenAI …'

    useEffect(() => {
      if (currentProvider !== PROVIDER_ID) {
        setBalance(null)
        return undefined
      }
      let cancelled = false
      async function load() {
        try {
          const payload = await getJson(`${API.balance}?provider=${encodeURIComponent(currentProvider)}`)
          if (!cancelled) setBalance(payload.data)
        } catch {
          if (!cancelled) setBalance(null)
        }
      }
      load()
      const timer = setInterval(() => { void load() }, BALANCE_POLL_MS)
      return () => {
        cancelled = true
        clearInterval(timer)
      }
    }, [currentProvider])

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
    // indicator is docked it is allowed to start a line of its own above the
    // others. The wrap belongs to the seat, so it is restored on the way out.
    useEffect(() => {
      if (floating === true || currentProvider !== PROVIDER_ID) return undefined
      const seat = flexSeatOf(nodeRef.current)
      if (seat === null) return undefined
      const previousWrap = seat.style.flexWrap
      seat.style.flexWrap = 'wrap'
      return () => { seat.style.flexWrap = previousWrap }
    }, [floating, currentProvider])

    // A shrinking window must not strand the panel outside the viewport.
    useEffect(() => {
      const onResize = () => {
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

    if (currentProvider !== PROVIDER_ID) return null

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

    const placement = panel === null
      ? {
          // The footer-action seat is one flex row shared with every other
          // registered action, and each occupant owns its button geometry. Take
          // a whole line of that (now wrapping) row and sort ahead of the other
          // occupants, so the indicator sits above them instead of squeezing or
          // covering them. The box counts its own padding and clips its own
          // text, so it can never spill onto a neighbour.
          flex: '1 1 100%',
          order: -1,
          minWidth: 0,
          boxSizing: 'border-box',
          textAlign: 'left',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }
      : {
          position: 'fixed',
          left: panel.x,
          top: panel.y,
          // The panel sizes to its own text. The docked width is the sidebar's,
          // and pinning it would cut the summary short; `maxWidth` only binds on
          // a viewport narrower than the text, where trimming is the least-bad
          // reading.
          whiteSpace: 'nowrap',
          maxWidth: Math.max(FLOAT_MARGIN_PX * 2, viewportSize().width - FLOAT_MARGIN_PX * 2),
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          zIndex: 40,
          boxShadow: '0 6px 18px rgba(0, 0, 0, 0.35)',
        }
    return h('button', {
      type: 'button',
      ref: nodeRef,
      style: {
        ...s.button,
        ...placement,
        cursor: dragging === true ? 'grabbing' : 'grab',
        touchAction: 'none',
        userSelect: 'none',
      },
      title: `OpenAI (ChatGPT OAuth) — ${parts.join(' / ')} · ${t('panelDragHint')}`,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick,
      onKeyDown,
    }, summary)
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
    attempt('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: CARD_KEY,
      inject: baseInject(ctx),
    }, OpenAISubscriptionCard))
    attempt('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: SIDEBAR_ID,
      inject: baseInject(ctx),
    }, BalanceSidebarIndicator))
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
    },
    enumerable: false,
  })
  module.exports = descriptor
  return module.exports
} })
