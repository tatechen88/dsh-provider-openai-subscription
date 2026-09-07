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
 * - the sidebar balance indicator (slot `sidebar.footer.action`).
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

  function BalanceSidebarIndicator(props) {
    const { sessionsService, modelDirectories, getLocale } = props
    const t = useT(getLocale)
    const currentProvider = useCurrentProvider(sessionsService, modelDirectories)
    const [balance, setBalance] = useState(null)
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

    if (currentProvider !== PROVIDER_ID) return null
    const windows = balance && Array.isArray(balance.windows) ? balance.windows : []
    const parts = windows
      .filter((window) => window.id === 'primary' || window.id === 'secondary')
      .map((window) => `${windowShortLabel(t, window)} ${window.remainingPercent}%`)
    const summary = parts.length > 0 ? `OpenAI ${parts.join(' · ')}` : 'OpenAI …'
    return h('button', {
      type: 'button',
      style: { ...s.button, width: '100%', textAlign: 'left' },
      title: `OpenAI (ChatGPT OAuth) — ${parts.join(' / ')}`,
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
    },
    enumerable: false,
  })
  module.exports = descriptor
  return module.exports
} })
