/**
 * Browser half of dsh-provider-openai-subscription.
 *
 * Renders a settings card for ChatGPT OAuth login, model status, and balance.
 * The browser never contacts OpenAI directly; all data flows through the
 * plugin's same-origin Host routes, which are already redacted.
 *
 * This file is a plain CommonJS module loaded by DSH's client module loader.
 */

window.__ModuleLoader__.load({ id: 'dsh-provider-openai-subscription', factory: (require) => {
  'use strict'

  const module = { exports: {} }

  const React = require('react')
  const { createElement: h, useEffect, useState, useCallback } = React

  const name = 'dsh-provider-openai-subscription'
  const inject = ['slots', 'sessions', 'modelDirectories']

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
  }

  async function getJson(url, options) {
    const response = await fetch(url, {
      ...(options || {}),
      headers: { accept: 'application/json', ...((options && options.headers) || {}) },
      cache: 'no-store',
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(payload && payload.error ? payload.error : `HTTP ${response.status}`)
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

  function formatTime(ts) {
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return '–'
    return new Date(ts).toLocaleString()
  }

  const styles = {
    card: { fontFamily: 'ui-sans-serif, system-ui, sans-serif', fontSize: 13, lineHeight: '20px', color: '#e5e7eb', padding: 4 },
    row: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '4px 0' },
    button: { background: '#1f2937', color: '#f9fafb', border: '1px solid #374151', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12 },
    link: { color: '#93c5fd', wordBreak: 'break-all' },
    error: { color: '#fca5a5', margin: '6px 0' },
    success: { color: '#86efac', margin: '6px 0' },
  }

  function selectionFromStore(store) {
    if (!store || typeof store.getSnapshot !== 'function') return null
    const snapshot = store.getSnapshot()
    return snapshot && snapshot.current && typeof snapshot.current.provider === 'string'
      ? snapshot.current
      : null
  }

  function useCurrentProvider(sessionsService, modelDirectories) {
    const [provider, setProvider] = useState(null)
    useEffect(() => {
      if (!sessionsService || !sessionsService.list || !modelDirectories) return undefined
      let stopList
      let stopDirectory
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
        if (typeof stopDirectory === 'function') stopDirectory()
      }
    }, [sessionsService, modelDirectories])
    return provider
  }

  function BalanceSidebarIndicator({ sessionsService, modelDirectories }) {
    const provider = useCurrentProvider(sessionsService, modelDirectories)
    const [balance, setBalance] = useState(null)
    useEffect(() => {
      if (provider !== 'openai-subscription') {
        setBalance(null)
        return undefined
      }
      let cancelled = false
      async function load() {
        try {
          const payload = await getJson(API.balance)
          if (!cancelled) setBalance(payload.data)
        } catch {
          if (!cancelled) setBalance(null)
        }
      }
      load()
      const timer = setInterval(() => { void load() }, 5 * 60 * 1000)
      return () => {
        cancelled = true
        clearInterval(timer)
      }
    }, [provider])

    if (provider !== 'openai-subscription') return null
    const primary = balance && balance.windows ? balance.windows.find((window) => window.id === 'primary') : undefined
    const summary = primary ? `OpenAI ${primary.remainingPercent}%` : 'OpenAI …'
    return h('button', {
      type: 'button',
      style: { ...styles.button, width: '100%', textAlign: 'left' },
      title: 'OpenAI (ChatGPT OAuth) Balance',
    }, summary)
  }

  function OpenAISubscriptionCard() {
    const [status, setStatus] = useState(null)
    const [balance, setBalance] = useState(null)
    const [models, setModels] = useState([])
    const [attempt, setAttempt] = useState(null)
    const [deviceAttempt, setDeviceAttempt] = useState(null)
    const [manualCode, setManualCode] = useState('')
    const [error, setError] = useState(null)
    const [loading, setLoading] = useState(false)

    const refreshStatus = useCallback(async () => {
      try {
        const payload = await getJson(API.status)
        setStatus(payload.data)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }, [])

    const refreshBalance = useCallback(async (force) => {
      try {
        const payload = force ? await postJson(API.balanceRefresh) : await getJson(API.balance)
        setBalance(payload.data)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }, [])

    const refreshModels = useCallback(async () => {
      try {
        const payload = await getJson(API.models)
        setModels(Array.isArray(payload.data) ? payload.data : [])
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }, [])

    useEffect(() => {
      void refreshStatus()
      void refreshBalance(false)
      const timer = setInterval(() => { void refreshStatus() }, 60 * 1000)
      return () => clearInterval(timer)
    }, [refreshStatus, refreshBalance])

    useEffect(() => {
      if (signedIn) void refreshModels()
    }, [signedIn, refreshModels])

    async function startLogin() {
      setError(null)
      setLoading(true)
      try {
        const payload = await postJson(API.start)
        setAttempt(payload.data)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    }

    async function submitCode() {
      if (!attempt || !manualCode.trim()) return
      setError(null)
      try {
        await postJson(API.code, { attemptId: attempt.attemptId, input: manualCode.trim() })
        setManualCode('')
        setAttempt(null)
        await refreshStatus()
        await refreshBalance(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }

    async function cancelLogin() {
      if (!attempt) return
      try {
        await postJson(API.cancel, { attemptId: attempt.attemptId })
      } finally {
        setAttempt(null)
        await refreshStatus()
      }
    }

    async function startDeviceLogin() {
      setError(null)
      setLoading(true)
      try {
        const payload = await postJson(API.deviceStart)
        setDeviceAttempt(payload.data)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    }

    async function cancelDeviceLogin() {
      if (!deviceAttempt) return
      try {
        await postJson(API.deviceCancel, { attemptId: deviceAttempt.attemptId })
      } finally {
        setDeviceAttempt(null)
        await refreshStatus()
      }
    }

    async function logout() {
      setError(null)
      try {
        await postJson(API.logout)
        setStatus({ configured: false })
        setBalance(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }

    const signedIn = status && status.configured === true

    return h('div', { style: styles.card }, [
      h('h3', { style: { margin: '0 0 8px', fontSize: 14 } }, 'OpenAI (ChatGPT OAuth)'),

      error ? h('div', { style: styles.error }, error) : null,

      h('div', { style: styles.row }, [
        h('span', null, signedIn ? '已登录' : '未登录'),
        signedIn && status.grant
          ? h('span', null, `${status.grant.accountId}${status.grant.email ? ` · ${status.grant.email}` : ''}`)
          : h('span', null, status ? '未配置' : '加载中…'),
      ]),

      signedIn ? h('div', null, [
        h('div', { style: styles.row }, [
          h('span', null, 'Balance'),
          h('button', { type: 'button', style: styles.button, onClick: () => void refreshBalance(true) }, '刷新'),
        ]),
        balance && balance.windows && balance.windows.length > 0
          ? balance.windows.map((window) => h('div', { key: window.id, style: styles.row }, [
              h('span', null, `${window.label}: ${window.remainingPercent}%`),
              h('span', null, window.resetsAt ? `重置 ${formatTime(window.resetsAt)}` : '无重置时间'),
            ]))
          : h('div', { style: styles.row }, [h('span', null, '暂无 Balance 数据')]),
        h('div', { style: { marginTop: 8 } }, [
          h('div', { style: styles.row }, [
            h('span', null, 'Models'),
            h('button', { type: 'button', style: styles.button, onClick: () => void refreshModels() }, '刷新'),
          ]),
          models.length > 0
            ? models.slice(0, 20).map((model) => h('div', { key: model.id, style: styles.row }, [
                h('span', null, model.name || model.id),
                h('span', { style: { color: '#9ca3af' } }, model.id),
              ]))
            : h('div', { style: styles.row }, [h('span', null, '暂无模型数据')]),
        ]),
        status && status.provider ? h('div', { style: { marginTop: 8 } }, [
          h('div', { style: styles.row }, [h('span', null, '默认模型'), h('span', null, status.provider.defaultModel || '–')]),
          h('div', { style: styles.row }, [h('span', null, 'Reasoning Effort'), h('span', null, status.provider.reasoningEffort || '–')]),
        ]) : null,
        h('div', { style: { marginTop: 8 } }, [
          h('button', { type: 'button', style: styles.button, onClick: () => void logout() }, '退出登录'),
        ]),
      ]) : null,

      !signedIn ? h('div', { style: { marginTop: 8 } }, [
        attempt
          ? h('div', null, [
              h('div', { style: styles.row }, [
                h('span', null, '请在浏览器完成登录'),
                h('a', { href: attempt.url, target: '_blank', rel: 'noreferrer', style: styles.link }, '打开授权页'),
              ]),
              h('input', {
                type: 'text',
                value: manualCode,
                onChange: (event) => setManualCode(event.target.value),
                placeholder: '粘贴回调 URL 或 code',
                style: { width: '100%', boxSizing: 'border-box', background: '#111827', color: '#f9fafb', border: '1px solid #374151', borderRadius: 8, padding: 6, margin: '6px 0' },
              }),
              h('div', { style: { display: 'flex', gap: 8 } }, [
                h('button', { type: 'button', style: styles.button, onClick: () => void submitCode() }, '提交'),
                h('button', { type: 'button', style: styles.button, onClick: () => void cancelLogin() }, '取消'),
              ]),
            ])
          : deviceAttempt
            ? h('div', null, [
                h('div', { style: styles.row }, [
                  h('span', null, '打开设备码页面'),
                  h('a', { href: deviceAttempt.verificationUri, target: '_blank', rel: 'noreferrer', style: styles.link }, '打开'),
                ]),
                h('div', { style: styles.row }, [
                  h('span', null, '设备码'),
                  h('strong', null, deviceAttempt.userCode),
                ]),
                h('div', { style: { display: 'flex', gap: 8 } }, [
                  h('button', { type: 'button', style: styles.button, onClick: () => void cancelDeviceLogin() }, '取消'),
                ]),
              ])
            : h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
                h('button', { type: 'button', style: styles.button, disabled: loading, onClick: () => void startLogin() }, loading ? '启动中…' : '使用 ChatGPT 登录'),
                h('button', { type: 'button', style: styles.button, disabled: loading, onClick: () => void startDeviceLogin() }, '使用设备码登录'),
              ]),
      ]) : null,
    ])
  }

  function apply(ctx) {
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: 'llm-openai-subscription',
      inject: () => ({}),
    }, OpenAISubscriptionCard))
    ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
      name: 'sidebar.footer.action',
      id: 'dsh-provider-openai-subscription-balance',
      inject: () => ({
        sessionsService: ctx.sessions,
        modelDirectories: ctx.modelDirectories,
      }),
    }, BalanceSidebarIndicator))
  }

  module.exports = { name, inject, apply }
  return module.exports
} })
