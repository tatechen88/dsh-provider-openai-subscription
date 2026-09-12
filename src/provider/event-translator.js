/**
 * OpenAI Responses SSE event translator.
 *
 * Converts the Responses API stream into DSH StreamChunk values.  The
 * translator is stateful because function-call deltas arrive as separate
 * events that must be correlated to the same output item, and because the
 * terminal usage reading may be carried by any terminal event.
 *
 * @module dsh-provider-openai-subscription/provider/event-translator
 */

/**
 * Whether one wire counter is a usable token count.
 * @param {unknown} value
 * @returns {boolean}
 */
function isTokenCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Read one nested details object without trusting a remote encoder's types.
 * @param {unknown} holder
 * @param {string} key
 * @returns {unknown}
 */
function detailOf(holder, key) {
  if (holder === null || typeof holder !== 'object' || Array.isArray(holder)) return undefined
  const details = /** @type {Record<string, unknown>} */ (holder)[key]
  return details !== null && typeof details === 'object' && !Array.isArray(details) ? details : undefined
}

/**
 * Map one Responses `usage` payload onto the harness TokenUsage convention.
 *
 * OpenAI's `input_tokens` aggregates cache reads (`input_tokens_details.
 * cached_tokens`) and `output_tokens` aggregates reasoning tokens
 * (`output_tokens_details.reasoning_tokens`), while harness counts are
 * DISJOINT: cache reads are subtracted out of `inputTokens`.  The exact
 * `totalTokens` is always reported because the harness refuses a cache-read
 * bucket that has no cache-write counterpart unless a total is present, and the
 * two aggregate counters define that total exactly.
 *
 * @param {unknown} raw - a terminal event's `response` object (or the event itself).
 * @returns {Record<string, unknown>|undefined} harness usage, or undefined when
 *   the payload carries no usable aggregate counters.
 */
export function usageFromResponse(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const usage = detailOf(raw, 'usage')
  if (usage === undefined) return undefined
  const inputTokens = usage.input_tokens
  const outputTokens = usage.output_tokens
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) return undefined

  const cached = detailOf(usage, 'input_tokens_details')?.cached_tokens
  // A cache read is a subset of the wire input count; a larger number is not a
  // cache hit, and subtracting it would produce a negative prompt count.
  const cacheHit = isTokenCount(cached) && cached <= inputTokens ? cached : undefined
  const reasoning = detailOf(usage, 'output_tokens_details')?.reasoning_tokens
  const reasoningTokens = isTokenCount(reasoning) && reasoning <= outputTokens ? reasoning : undefined

  const combined = inputTokens + outputTokens
  const totalTokens = Number.isSafeInteger(combined) ? combined : undefined
  // Without a total the harness drops the whole reading, so an unusable total
  // costs the cache field alone.
  const cacheReadTokens = totalTokens === undefined ? undefined : cacheHit

  return {
    inputTokens: inputTokens - (cacheReadTokens ?? 0),
    outputTokens,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  }
}

/**
 * Translator from parsed Responses events to DSH chunks.
 */
export class ResponsesEventTranslator {
  constructor() {
    /** @type {Map<string, number>} */
    this.itemIndexes = new Map()
    /** @type {Map<number, {name: string, callId: string}>} */
    this.itemMeta = new Map()
    this.nextIndex = 0
    this.terminal = false
    this.usageEmitted = false
  }

  /**
   * At most one usage chunk: the harness rejects a second one, and every
   * terminal event of one response carries the same reading.
   * @param {unknown} response - the terminal event's response payload.
   * @returns {Array<Record<string, unknown>>} zero or one usage chunk.
   */
  #usageChunks(response) {
    if (this.usageEmitted) return []
    const usage = usageFromResponse(response === undefined ? undefined : response)
    if (usage === undefined) return []
    this.usageEmitted = true
    return [{ type: 'usage', usage }]
  }

  /**
   * Push one parsed event object.
   * @param {unknown} raw
   * @returns {Array<Record<string, unknown>>} DSH stream chunks.
   */
  push(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
    const event = /** @type {Record<string, unknown>} */ (raw)
    const type = event.type
    const chunks = []
    switch (type) {
      case 'response.output_item.added': {
        const item = event.item
        if (item !== null && typeof item === 'object' && item.type === 'function_call') {
          const index = this.#indexFor(String(item.id ?? item.call_id ?? 'call'))
          const meta = {
            name: typeof item.name === 'string' ? item.name : '',
            callId: String(item.call_id ?? item.id ?? 'call'),
          }
          this.itemMeta.set(index, meta)
          chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
          chunks.push({ type: 'tool-call-delta', index, id: meta.callId, name: meta.name, argumentsDelta: '' })
        }
        break
      }
      case 'response.output_text.delta': {
        if (typeof event.delta !== 'string') break
        const index = typeof event.output_index === 'number' ? event.output_index : this.nextIndex
        this.nextIndex = Math.max(this.nextIndex, index + 1)
        chunks.push({ type: 'text-delta', index, text: event.delta })
        break
      }
      case 'response.output_text.done': {
        const index = typeof event.output_index === 'number' ? event.output_index : this.nextIndex
        const text = typeof event.text === 'string' ? event.text : ''
        chunks.push({ type: 'block-end', index, block: { type: 'text', text } })
        break
      }
      case 'response.function_call_arguments.delta': {
        const index = this.#indexFor(String(event.item_id ?? ''))
        if (typeof event.delta === 'string') {
          chunks.push({ type: 'tool-call-delta', index, id: String(event.call_id ?? ''), argumentsDelta: event.delta })
        }
        break
      }
      case 'response.function_call_arguments.done': {
        const index = this.#indexFor(String(event.item_id ?? ''))
        const meta = this.itemMeta.get(index) ?? { name: '', callId: '' }
        chunks.push({
          type: 'block-end',
          index,
          block: {
            type: 'tool-call',
            id: meta.callId || String(event.call_id ?? ''),
            name: meta.name || String(event.name ?? ''),
            arguments: String(event.arguments ?? ''),
          },
        })
        break
      }
      case 'response.completed':
        this.terminal = true
        // Usage rides the terminal event and must precede the finish chunk.
        chunks.push(...this.#usageChunks(event.response ?? event))
        chunks.push({ type: 'finish', reason: { kind: 'stop' } })
        break
      case 'response.failed':
      case 'response.incomplete':
        this.terminal = true
        // A truncated or failed response still bills the tokens it produced.
        chunks.push(...this.#usageChunks(event.response ?? event))
        chunks.push({ type: 'finish', reason: { kind: 'error', failure: { message: typeof event.message === 'string' ? event.message : 'OpenAI response did not complete', code: type } } })
        break
      case 'error':
        this.terminal = true
        chunks.push({ type: 'finish', reason: { kind: 'error', failure: { message: typeof event.message === 'string' ? event.message : 'OpenAI stream error', code: 'provider-error' } } })
        break
      default:
        break
    }
    return chunks
  }

  /**
   * Finalize a stream that never reached a terminal event. Every terminal event
   * already emitted its own finish, and a second one would both replace the
   * real failure reason in the assembler and break the stream grammar the
   * harness validates.
   * @returns {Array<Record<string, unknown>>}
   */
  end() {
    if (this.terminal) return []
    this.terminal = true
    return [{ type: 'finish', reason: { kind: 'error', failure: { message: 'OpenAI stream ended without completion', code: 'STREAM_CLOSED' } } }]
  }

  #indexFor(id) {
    let index = this.itemIndexes.get(id)
    if (index === undefined) {
      index = this.nextIndex
      this.itemIndexes.set(id, index)
      this.nextIndex += 1
    }
    return index
  }
}
