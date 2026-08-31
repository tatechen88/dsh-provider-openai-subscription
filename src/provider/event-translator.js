/**
 * OpenAI Responses SSE event translator.
 *
 * Converts the Responses API stream into DSH StreamChunk values.  The
 * translator is stateful because function-call deltas arrive as separate
 * events that must be correlated to the same output item.
 *
 * @module dsh-provider-openai-subscription/provider/event-translator
 */

/**
 * Translator from parsed Responses events to DSH chunks.
 */
export class ResponsesEventTranslator {
  constructor() {
    /** @type {Map<string, number>} */
    this.itemIndexes = new Map()
    this.nextIndex = 0
    this.completed = false
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
          const index = this.#indexFor(String(item.id ?? 'call'))
          chunks.push({ type: 'block-start', index, blockType: 'tool-call' })
          chunks.push({ type: 'tool-call-delta', index, id: String(item.call_id ?? item.id ?? 'call'), name: typeof item.name === 'string' ? item.name : undefined, argumentsDelta: '' })
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
        chunks.push({ type: 'block-end', index, block: { type: 'tool-call', id: String(event.call_id ?? ''), name: String(event.name ?? ''), arguments: String(event.arguments ?? '') } })
        break
      }
      case 'response.completed':
        this.completed = true
        chunks.push({ type: 'finish', reason: { kind: 'stop' } })
        break
      case 'response.failed':
      case 'response.incomplete':
        chunks.push({ type: 'finish', reason: { kind: 'error', failure: { message: typeof event.message === 'string' ? event.message : 'OpenAI response did not complete', code: type } } })
        break
      case 'error':
        chunks.push({ type: 'finish', reason: { kind: 'error', failure: { message: typeof event.message === 'string' ? event.message : 'OpenAI stream error', code: 'provider-error' } } })
        break
      default:
        break
    }
    return chunks
  }

  /**
   * Finalize an incomplete stream.
   * @returns {Array<Record<string, unknown>>}
   */
  end() {
    if (this.completed) return []
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
