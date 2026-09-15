/**
 * DeepSeek official balance contracts.
 *
 * @module dsh-provider-openai-subscription/test/usage-deepseek-balance
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEEPSEEK_OFFICIAL_HOST,
  DeepSeekBalanceError,
  fetchDeepSeekBalance,
  normalizeBalanceInfos,
  pickPrimaryInfo,
  resolveOfficialEndpoint,
} from '../src/usage/deepseek-balance.js'

test('only the official HTTPS host may receive the DeepSeek key', () => {
  assert.equal(resolveOfficialEndpoint(undefined), `https://${DEEPSEEK_OFFICIAL_HOST}/user/balance`)
  assert.equal(resolveOfficialEndpoint('https://api.deepseek.com'), `https://${DEEPSEEK_OFFICIAL_HOST}/user/balance`)
  assert.equal(resolveOfficialEndpoint('https://api.deepseek.com/v1/'), `https://${DEEPSEEK_OFFICIAL_HOST}/user/balance`)
  assert.equal(resolveOfficialEndpoint('http://api.deepseek.com'), null, 'plaintext is refused')
  assert.equal(resolveOfficialEndpoint('https://api.deepseek.com.evil.test'), null, 'a look-alike host is refused')
  assert.equal(resolveOfficialEndpoint('https://relay.example.com/v1'), null, 'a proxy is refused')
  assert.equal(resolveOfficialEndpoint('not a url'), null)
})

test('every currency row survives normalization and a funded CNY row leads', () => {
  const snapshot = normalizeBalanceInfos({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '0.00', granted_balance: '0.00', topped_up_balance: '0.00' },
      { currency: 'CNY', total_balance: '86.20', granted_balance: '6.20', topped_up_balance: '80.00' },
    ],
  })
  assert.equal(snapshot.available, true)
  assert.equal(snapshot.infos.length, 2)
  assert.equal(snapshot.primary.currency, 'CNY')
  assert.equal(snapshot.primary.total, 86.2)
  assert.equal(snapshot.primary.granted, 6.2)
  assert.equal(snapshot.primary.toppedUp, 80)
})

test('a zero-CNY account still resolves a primary row', () => {
  assert.equal(pickPrimaryInfo([]), undefined)
  const snapshot = normalizeBalanceInfos({
    is_available: false,
    balance_infos: [
      { currency: 'USD', total_balance: '5.00' },
      { currency: 'CNY', total_balance: '0.00' },
    ],
  })
  assert.equal(snapshot.primary.currency, 'USD', 'a funded row beats an empty CNY row')
  assert.equal(snapshot.primary.granted, 0)
  assert.equal(snapshot.available, false)
})

test('a malformed balance body is rejected instead of read as zero', () => {
  assert.throws(() => normalizeBalanceInfos({}), (error) => error instanceof DeepSeekBalanceError && error.code === 'malformed-response')
  assert.throws(() => normalizeBalanceInfos(null), DeepSeekBalanceError)
  const empty = normalizeBalanceInfos({ balance_infos: [{ currency: 'CNY', total_balance: 'not-a-number' }] })
  assert.deepEqual(empty.infos, [], 'an unreadable amount is dropped, never coerced to zero money')
})

test('the request carries the key only to the official endpoint', async () => {
  let seen
  const snapshot = await fetchDeepSeekBalance({
    baseURL: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test',
    now: () => 1234,
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }), { status: 200 })
    },
  })
  assert.equal(seen.url, `https://${DEEPSEEK_OFFICIAL_HOST}/user/balance`)
  assert.equal(seen.init.headers.authorization, 'Bearer sk-test')
  assert.equal(seen.init.redirect, 'error')
  assert.equal(snapshot.fetchedAt, 1234)
})

test('an unconfigured key or an unofficial base URL never reaches the network', async () => {
  let called = false
  const fetchImpl = async () => {
    called = true
    return new Response('{}', { status: 200 })
  }
  await assert.rejects(
    () => fetchDeepSeekBalance({ baseURL: 'https://api.deepseek.com', apiKey: '', fetchImpl }),
    (error) => error.code === 'unconfigured',
  )
  await assert.rejects(
    () => fetchDeepSeekBalance({ baseURL: 'https://relay.example.com', apiKey: 'sk-test', fetchImpl }),
    (error) => error.code === 'unsupported-endpoint',
  )
  assert.equal(called, false, 'the key is never sent to a refused host')
})

test('an HTTP failure is classified instead of being shown as a balance', async () => {
  await assert.rejects(
    () => fetchDeepSeekBalance({
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      fetchImpl: async () => new Response('nope', { status: 401 }),
    }),
    (error) => error.code === 'http' && /401/.test(error.message),
  )
})
