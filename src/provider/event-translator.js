/**
 * OpenAI Responses SSE event translator.
 *
 * Converts the Responses API stream into DSH StreamChunk values.  The
 * translator is stateful because function-call deltas arrive as separate
 * events that must be correlated to the same output item, and because the
 * terminal usage reading may be carried by any terminal event.
 *
 * The harness validates the stream grammar: a delta is only legal inside an
 * open block of its own type, `block-end` only closes an open block, a
 * terminal finish is emitted once, and a successful finish may not leave a
 * block open.  The Responses wire format has no "block started" event, so this
 * translator opens blocks itself and closes what is still open before a
 * successful finish.
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
 * Whether one wire value is usable as a block index.
 * @param {unknown} value
 * @returns {boolean}
 */
function isBlockIndex(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
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
    /** @type {Map<string, number>} function-call item key to block index. */
    this.itemIndexes = new Map()
    /** @type {Map<number, {name: string, callId: string}>} */
    this.itemMeta = new Map()
    /** @type {Map<string, number>} text-run key to block index. */
    this.textIndexes = new Map()
    /** @type {Map<number, string>} block index to its open block type. */
    this.openBlocks = new Map()
    /** @type {Set<number>} indexes already closed; a closed index is never reopened. */
    this.closedIndexes = new Set()
    /** @type {Set<number>} every index any block has used. */
    this.usedIndexes = new Set()
    /** @type {Map<number, string>} streamed text per block index. */
    this.textBuffers = new Map()
    /** @type {Map<number, string>} streamed tool arguments per block index. */
    this.argumentsBuffers = new Map()
    this.nextIndex = 0
    this.terminal = false
    this.usageEmitted = false
  }

  /**
   * Mark one block index used, so no later item can be assigned it.
   * @param {number} index
   * @returns {number} the same index.
   */
  #reserve(index) {
    this.usedIndexes.add(index)
    if (index >= this.nextIndex) this.nextIndex = index + 1
    return index
  }

  /** Allocate the lowest index no block has used yet. */
  #allocate() {
    let index = this.nextIndex
    while (this.usedIndexes.has(index)) index += 1
    return this.#reserve(index)
  }

  /**
   * Open one block.  Nothing is emitted when the index is already open as this
   * type, and a previously closed index is never reopened: the harness rejects
   * a repeated `block-start`, so the caller must allocate a fresh index instead.
   * @param {number} index
   * @param {string} blockType
   * @returns {Array<Record<string, unknown>>} zero or one block-start chunk.
   */
  #open(index, blockType) {
    if (this.openBlocks.has(index)) return []
    if (this.closedIndexes.has(index)) return []
    this.openBlocks.set(index, blockType)
    this.#reserve(index)
    return [{ type: 'block-start', index, blockType }]
  }

  /**
   * Close the open block at `index` with `block`.
   * @param {number} index
   * @param {Record<string, unknown>} block
   * @returns {Array<Record<string, unknown>>} zero or one block-end chunk.
   */
  #close(index, block) {
    if (this.openBlocks.get(index) !== block.type) return []
    this.openBlocks.delete(index)
    this.closedIndexes.add(index)
    return [{ type: 'block-end', index, block }]
  }

  /**
   * The stable block index of one function-call item, keyed by item id when the
   * wire carries one and by `output_index` otherwise — the same fallback the
   * text runs use, so an event that dropped the id still lands on its block.
   * @param {Record<string, unknown>} event
   * @returns {number}
   */
  #indexForItem(event) {
    const itemId = event.item_id
    const key = typeof itemId === 'string' && itemId.length > 0
      ? `item:${itemId}`
      : isBlockIndex(event.output_index)
        ? `out:${String(event.output_index)}`
        : 'call'
    const known = this.itemIndexes.get(key)
    if (known !== undefined && !this.closedIndexes.has(known)) return known
    const wireIndex = event.output_index
    const index = known !== undefined
      ? this.#allocate()
      : isBlockIndex(wireIndex) && !this.usedIndexes.has(wireIndex)
        ? this.#reserve(wireIndex)
        : this.#allocate()
    this.itemIndexes.set(key, index)
    if (isBlockIndex(wireIndex)) this.itemIndexes.set(`out:${String(wireIndex)}`, index)
    return index
  }

  /**
   * The stable block index of one text run, keyed by item id when the wire
   * carries one and by `output_index` otherwise.
   * @param {Record<string, unknown>} event
   * @returns {number}
   */
  #indexForText(event) {
    const itemId = event.item_id
    const key = typeof itemId === 'string' && itemId.length > 0
      ? `item:${itemId}`
      : isBlockIndex(event.output_index)
        ? `out:${String(event.output_index)}`
        : 'text'
    const known = this.textIndexes.get(key)
    if (known !== undefined && !this.closedIndexes.has(known)) return known
    const wireIndex = event.output_index
    const index = known !== undefined
      ? this.#allocate()
      : isBlockIndex(wireIndex) && !this.usedIndexes.has(wireIndex)
        ? this.#reserve(wireIndex)
        : this.#allocate()
    this.textIndexes.set(key, index)
    if (isBlockIndex(wireIndex)) this.textIndexes.set(`out:${String(wireIndex)}`, index)
    return index
  }

  /**
   * Close every block still open, so a successful finish leaves none behind.
   * @returns {Array<Record<string, unknown>>} block-end chunks in open order.
   */
  #closeOpenBlocks() {
    const chunks = []
    for (const [index, blockType] of [...this.openBlocks]) {
      if (blockType === 'text') {
        chunks.push(...this.#close(index, { type: 'text', text: this.textBuffers.get(index) ?? '' }))
      } else if (blockType === 'tool-call') {
        const meta = this.itemMeta.get(index) ?? { name: '', callId: '' }
        chunks.push(...this.#close(index, {
          type: 'tool-call',
          id: meta.callId,
          name: meta.name,
          arguments: this.argumentsBuffers.get(index) ?? '',
        }))
      } else {
        // An unknown open type cannot be assembled into a block; dropping the
        // open marker keeps the terminal finish legal.
        this.openBlocks.delete(index)
        this.closedIndexes.add(index)
      }
    }
    return chunks
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
   *
   * Events after a terminal one are ignored: the harness rejects any chunk
   * that follows a finish, and every terminal event of a response carries the
   * same terminal facts.
   *
   * @param {unknown} raw
   * @returns {Array<Record<string, unknown>>} DSH stream chunks.
   */
  push(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return []
    if (this.terminal) return []
    const event = /** @type {Record<string, unknown>} */ (raw)
    const type = event.type
    const chunks = []
    switch (type) {
      case 'response.output_item.added': {
        const item = event.item
        if (item !== null && typeof item === 'object' && !Array.isArray(item)
          && /** @type {Record<string, unknown>} */ (item).type === 'function_call') {
          const record = /** @type {Record<string, unknown>} */ (item)
          // The added event carries the item in `item`; its id keys the block,
          // and the event's own `output_index` is the fallback.
          const index = this.#indexForItem({
            item_id: record.id ?? record.call_id,
            output_index: event.output_index,
          })
          const meta = {
            name: typeof record.name === 'string' ? record.name : '',
            callId: String(record.call_id ?? record.id ?? 'call'),
          }
          this.itemMeta.set(index, meta)
          chunks.push(...this.#open(index, 'tool-call'))
          chunks.push({ type: 'tool-call-delta', index, id: meta.callId, name: meta.name, argumentsDelta: '' })
        }
        break
      }
      case 'response.output_text.delta': {
        if (typeof event.delta !== 'string') break
        const index = this.#indexForText(event)
        chunks.push(...this.#open(index, 'text'))
        this.textBuffers.set(index, (this.textBuffers.get(index) ?? '') + event.delta)
        chunks.push({ type: 'text-delta', index, text: event.delta })
        break
      }
      case 'response.output_text.done': {
        const index = this.#indexForText(event)
        chunks.push(...this.#open(index, 'text'))
        const text = typeof event.text === 'string' ? event.text : this.textBuffers.get(index) ?? ''
        chunks.push(...this.#close(index, { type: 'text', text }))
        break
      }
      case 'response.function_call_arguments.delta': {
        const index = this.#indexForItem(event)
        chunks.push(...this.#open(index, 'tool-call'))
        if (typeof event.delta === 'string') {
          const meta = this.itemMeta.get(index)
          if (meta === undefined) this.itemMeta.set(index, { name: '', callId: String(event.call_id ?? '') })
          this.argumentsBuffers.set(index, (this.argumentsBuffers.get(index) ?? '') + event.delta)
          chunks.push({ type: 'tool-call-delta', index, id: String(event.call_id ?? ''), argumentsDelta: event.delta })
        }
        break
      }
      case 'response.function_call_arguments.done': {
        const index = this.#indexForItem(event)
        chunks.push(...this.#open(index, 'tool-call'))
        const meta = this.itemMeta.get(index) ?? { name: '', callId: '' }
        const args = typeof event.arguments === 'string'
          ? event.arguments
          : this.argumentsBuffers.get(index) ?? ''
        chunks.push(...this.#close(index, {
          type: 'tool-call',
          id: meta.callId || String(event.call_id ?? ''),
          name: meta.name || String(event.name ?? ''),
          arguments: args,
        }))
        break
      }
      case 'response.completed':
        this.terminal = true
        // Usage rides the terminal event and must precede the finish chunk.
        chunks.push(...this.#closeOpenBlocks())
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
}
