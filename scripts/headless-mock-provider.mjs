/**
 * Mock model provider for the headless smoke.
 *
 * `dsh --profile headless` needs a working model route to produce a run, and a
 * real one would cost a network call and an API key. This registers an adapter
 * that answers with one canned text block over a legal `llm/stream` sequence,
 * so the smoke exercises the real launcher, the real agent loop, and this
 * plugin's metering without leaving the machine.
 *
 * It is inserted by an absolute path from the smoke's generated profile patch;
 * nothing composes it in a shipped profile.
 *
 * The adapter is duck-typed rather than extending `LlmAdapter`: this file lives
 * in the plugin checkout, whose real path a `link:` install keeps outside the
 * profile, so a bare `@deepseek-ai/dsh-llm` import would not resolve from here.
 *
 * @module dsh-provider-openai-subscription/scripts/headless-mock-provider
 */

/** Provider route this adapter answers for. */
export const MOCK_PROVIDER = 'headless-mock'

/** Model id this adapter advertises. */
export const MOCK_MODEL = 'mock-1'

/** The one answer every call produces. */
export const MOCK_TEXT = 'mock answer from the headless smoke'

/**
 * One legal chunk stream: the harness validates the block grammar, so the reply
 * opens its block, closes it, reports usage and then finishes.
 * @returns {AsyncGenerator<Record<string, unknown>>} the chunk stream.
 */
async function* mockStream() {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: MOCK_TEXT }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: MOCK_TEXT } }
  yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** The adapter surface `LlmRuntime` dispatches to. */
const mockAdapter = {
  providerInfo: (provider) => ({ id: provider, name: 'Headless mock' }),
  providerRetryPolicy: () => undefined,
  listModels: async (provider) => [{ provider, id: MOCK_MODEL, name: 'Mock 1' }],
  resolveModel: async (provider, model) => ({ provider, id: model, name: model }),
  prepareCall: async (provider, model) => ({
    model: { provider, id: model, name: model },
    stream: () => mockStream(),
  }),
  stream: () => mockStream(),
}

export const name = 'headless-mock-provider'
export const inject = ['llm']

/**
 * Register the mock route with the harness.
 * @param {object} ctx - Cordis context.
 * @returns {void}
 */
export function apply(ctx) {
  ctx.effect(() => ctx.llm.registerAdapter([MOCK_PROVIDER], mockAdapter))
}
