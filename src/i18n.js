/**
 * The words this plugin says to a person, in the language they are using.
 *
 * Everything user-facing is here: tool descriptions a model reads before
 * deciding to call, error sentences a person reads in the chat, and the few
 * words the one HTTP route answers with. Machine-facing values — JSON keys,
 * status codes, error `code` fields, model ids — stay English on purpose: they
 * are matched by programs, not read by people.
 *
 * Which language is "current" is resolved once per activation, in this order:
 *
 * 1. the harness's own locale preference (the `locale` settings namespace the
 *    Language row writes — the same source the client reads back);
 * 2. the process locale (`Intl`'s resolved option, which follows the OS);
 * 3. English.
 *
 * Resolved once, because tool descriptions are registered at activation and a
 * registration cannot be re-worded in place. A language change therefore takes
 * effect the next time this plugin activates; that is stated in the README.
 *
 * @module dsh-provider-openai-subscription/i18n
 */

/** The language a locale id resolves to for this plugin's dictionaries. */
const DICTIONARIES = ['en', 'zh']

/**
 * Map one locale id onto a dictionary.
 *
 * `zh` covers every Chinese variant; an unknown id falls back to English rather
 * than to the OS, so an exotic preference still yields complete sentences.
 *
 * @param {string|undefined} locale - a BCP-47-ish id, or nothing.
 * @returns {'en'|'zh'} the dictionary to read.
 */
export function dictionaryFor(locale) {
  if (typeof locale !== 'string') return 'en'
  const lower = locale.toLowerCase()
  if (lower.startsWith('zh')) return 'zh'
  return 'en'
}

/**
 * Read the harness's own locale preference, when it is reachable.
 *
 * @param {object} [settings] - a `settings` service face (`describe()`).
 * @returns {Promise<string|undefined>} the stored preference, or nothing.
 */
async function preferenceFromSettings(settings) {
  if (typeof settings?.describe !== 'function') return undefined
  try {
    const descriptors = await settings.describe()
    const found = Array.isArray(descriptors)
      ? descriptors.find((entry) => entry?.ns === 'locale')
      : undefined
    const preference = found?.value?.preference
    return typeof preference === 'string' && preference.length > 0 ? preference : undefined
  } catch {
    // A preference that cannot be read is a fallback case, not a failure.
    return undefined
  }
}

/**
 * Resolve the language this activation should speak.
 *
 * @param {object} [options]
 * @param {object} [options.settings] - the `settings` service, when visible.
 * @param {() => string} [options.processLocale] - the process locale; a seam.
 * @returns {Promise<'en'|'zh'}}
 */
export async function resolveLanguage({ settings, processLocale = () => Intl.DateTimeFormat().resolvedOptions().locale } = {}) {
  const preferred = await preferenceFromSettings(settings)
  if (preferred !== undefined) return dictionaryFor(preferred)
  return dictionaryFor(processLocale())
}

/** English: the dictionary every key must exist in. */
const en = {
  'tool.status.description': 'Report the OpenAI subscription sign-in state: whether a ChatGPT credential is stored, which account it belongs to, when it expires, and whether a sign-in is currently waiting for the user to finish in a browser. Read-only; call it before and after a login instead of guessing.',
  'tool.status.title': 'OpenAI subscription status',
  'tool.login.description': 'Start signing in to a ChatGPT subscription so its models can be used. Returns a link the user must open in their own browser; the call waits briefly for them to finish and then reports either the finished sign-in or that it is still pending. A pending sign-in keeps running, so continue with the status tool rather than starting a second one.',
  'tool.login.title': 'Sign in to ChatGPT',
  'tool.login.param.method': "How the user signs in. 'oauth' (default) opens a link in their browser; 'device' shows a code they enter on another device, for machines with no browser.",
  'tool.login.param.wait_seconds': 'How long to wait for the sign-in to finish before reporting it pending. Defaults to 60.',
  'tool.logout.description': 'Forget the stored ChatGPT credential and stop any sign-in that is still waiting. The subscription itself is untouched — this only removes the local record, and signing in again is a new login.',
  'tool.logout.title': 'Sign out of ChatGPT',
  'tool.quota.description': "Report how much of the ChatGPT subscription quota is left: the rate-limit windows the account reports, each with the percentage used, when it resets, and whether it is exhausted. This is the subscription's own limit, not a money balance.",
  'tool.quota.title': 'Subscription quota',
  'tool.quota.param.refresh': 'Ask the vendor now instead of answering from the cached reading.',
  'tool.usage.description': 'Report what this deployment has called and what it cost: tokens and estimated amounts for today, this month, and optionally the current session, plus any models that have no price (those calls look free and are not). Amounts are estimates priced at request start, and the report says which currency they are in.',
  'tool.usage.title': 'Usage and cost',
  'tool.usage.param.scope': "Which slice to report: 'today' (default), 'month', 'session', or 'all'.",
  'op.login.hint': 'open the link above, then call this again or check the status',
  'op.login.no-seam': 'no authorization service is mounted in this deployment',
  'op.login.prompt-refused': 'this surface cannot ask a question; use a method that needs no answer',
  'route.error.auth': 'authentication required',
  'route.error.origin': 'untrusted origin',
  'adapter.error.network': 'OpenAI Responses request failed: {message}',
  'adapter.error.unauthorized': 'OpenAI subscription credential was rejected; sign in again (HTTP {status})',
  'adapter.error.empty-body': 'OpenAI Responses returned no body',
  'adapter.error.upstream': 'OpenAI Responses returned HTTP {status}{detail} | request: {request}',
  'adapter.error.usage-limit': 'ChatGPT subscription {window} usage limit reached{plan}: it {timing}. Use another model until then; openai_subscription_quota reports every window.',
  'adapter.error.usage-limit.window': '{hours}-hour',
  'adapter.error.usage-limit.resets-in': 'resets in about {minutes} minute(s)',
  'adapter.error.usage-limit.already-reset': 'has already reset, so a retry should work',
  'adapter.error.usage-limit.unreported': 'its reset time was not reported',
  'adapter.error.usage-limit.at': 'at {time}',
  'adapter.error.usage-limit.plan': ', plan: {plan}',
}

/** Chinese: must carry exactly the keys English carries. */
const zh = {
  'tool.status.description': '报告 OpenAI 订阅的登录状态：本机是否存有 ChatGPT 凭据、属于哪个账号、何时到期，以及是否有一次登录正在等用户在浏览器里完成。只读；登录前后各查一次，别靠猜。',
  'tool.status.title': 'OpenAI 订阅状态',
  'tool.login.description': '开始登录 ChatGPT 订阅，以便使用它的模型。会返回一条必须由用户在自己浏览器里打开的链接；调用会先等一小会儿，然后报告登录完成或仍在进行中。进行中的登录不会被打断，用状态工具继续跟进即可，不要发起第二次。',
  'tool.login.title': '登录 ChatGPT',
  'tool.login.param.method': "用户以哪种方式登录。'oauth'（默认）在浏览器里打开链接；'device' 显示一个在其它设备上输入的验证码，适合没有浏览器的机器。",
  'tool.login.param.wait_seconds': '等待登录完成的秒数，超时后报告“进行中”。默认 60。',
  'tool.logout.description': '忘掉本机保存的 ChatGPT 凭据，并停止仍在等待的登录。订阅本身不受影响——这里只删除本地记录，重新登录即可。',
  'tool.logout.title': '退出 ChatGPT 登录',
  'tool.quota.description': '报告 ChatGPT 订阅额度还剩多少：账号上报的各限流窗口、每个窗口已用的百分比、何时重置、是否已耗尽。这是订阅自身的限额，不是余额。',
  'tool.quota.title': '订阅额度',
  'tool.quota.param.refresh': '现在就去问一次服务商，而不是用缓存的读数回答。',
  'tool.usage.description': '报告这套 DSH 实际调用了什么、花了多少：今日 / 本月 /（可选）本会话的 token 与估算金额，以及没有价格的模型（它们的调用看起来免费，其实不是）。金额是按请求开始时刻的价格估算的，报告会注明币种。',
  'tool.usage.title': '用量与费用',
  'tool.usage.param.scope': "报告哪一段：'today'（默认）、'month'、'session' 或 'all'。",
  'op.login.hint': '打开上面的链接，然后再次调用本工具或查看状态',
  'op.login.no-seam': '当前部署没有挂载授权服务',
  'op.login.prompt-refused': '这个入口无法向用户提问；请改用不需要回答的登录方式',
  'route.error.auth': '需要先完成认证',
  'route.error.origin': '不受信任的来源',
  'adapter.error.network': 'OpenAI Responses 请求失败：{message}',
  'adapter.error.unauthorized': 'OpenAI 订阅凭据被拒绝；请重新登录（HTTP {status}）',
  'adapter.error.empty-body': 'OpenAI Responses 没有返回内容',
  'adapter.error.upstream': 'OpenAI Responses 返回 HTTP {status}{detail} | 请求: {request}',
  'adapter.error.usage-limit': 'ChatGPT 订阅的{window}额度已用尽{plan}：{timing}。在此之前请改用其它模型；openai_subscription_quota 可查看每个窗口。',
  'adapter.error.usage-limit.window': '{hours}小时',
  'adapter.error.usage-limit.resets-in': '约 {minutes} 分钟后重置',
  'adapter.error.usage-limit.already-reset': '已经重置，现在重试即可',
  'adapter.error.usage-limit.unreported': '服务端未报告重置时间',
  'adapter.error.usage-limit.at': '（本地 {time}）',
  'adapter.error.usage-limit.plan': '（套餐: {plan}）',
}

/** Both dictionaries, keyed by language. */
const DICTIONARY_BY_LANGUAGE = Object.freeze({ en: Object.freeze(en), zh: Object.freeze(zh) })

/**
 * Build the translator for one language.
 *
 * @param {'en'|'zh'} language
 * @returns {(key: string, params?: Record<string, string|number>) => string}
 */
export function translatorFor(language) {
  const dictionary = DICTIONARY_BY_LANGUAGE[language] ?? DICTIONARY_BY_LANGUAGE.en
  return (key, params) => {
    const template = dictionary[key] ?? DICTIONARY_BY_LANGUAGE.en[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match))
  }
}

/**
 * Assert the dictionaries agree, for the test that keeps them honest.
 * @returns {string[]} keys missing from one dictionary or the other.
 */
export function dictionaryGaps() {
  const gaps = []
  for (const key of Object.keys(en)) if (Object.hasOwn(zh, key) === false) gaps.push(`zh missing ${key}`)
  for (const key of Object.keys(zh)) if (Object.hasOwn(en, key) === false) gaps.push(`en missing ${key}`)
  return gaps
}

/** The languages this plugin can speak, in declaration order. */
export const LANGUAGES = Object.freeze([...DICTIONARIES])
