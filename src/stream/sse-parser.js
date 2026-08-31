/**
 * Streaming SSE parser.
 *
 * A small, well-tested incremental parser for `text/event-stream` responses.
 * It handles LF/CRLF, multi-line `data`, comments, event names, and the
 * conventional `[DONE]` sentinel as data.
 *
 * @module dsh-provider-openai-subscription/stream/sse-parser
 */

/**
 * One parsed SSE event.
 * @typedef {object} SseEvent
 * @property {string} [event]
 * @property {string} data
 */

/**
 * Incremental SSE parser.
 */
export class SseParser {
  constructor() {
    /** @type {string} */
    this.buffer = ''
    /** @type {string|undefined} */
    this.eventName = undefined
    /** @type {string[]} */
    this.dataLines = []
  }

  /**
   * Push a chunk of text.
   * @param {string|Uint8Array|Buffer} chunk
   * @returns {SseEvent[]} complete events emitted by this chunk.
   */
  push(chunk) {
    const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
    this.buffer += text
    const events = []
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
      if (normalized === '') {
        const event = this.#dispatch()
        if (event !== undefined) events.push(event)
      } else if (!normalized.startsWith(':')) {
        const colon = normalized.indexOf(':')
        const field = colon < 0 ? normalized : normalized.slice(0, colon)
        const value = colon < 0 ? '' : normalized.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') this.eventName = value
        else if (field === 'data') this.dataLines.push(value)
      }
    }
    return events
  }

  /**
   * Flush any trailing event (no trailing newline).
   * @returns {SseEvent[]}
   */
  end() {
    const events = []
    if (this.buffer.length > 0) {
      const trailing = `${this.buffer}\n`
      this.buffer = ''
      events.push(...this.push(trailing))
    }
    if (this.dataLines.length > 0 || this.eventName !== undefined) {
      const event = this.#dispatch()
      if (event !== undefined) events.push(event)
    }
    return events
  }

  /**
   * Build and reset one event.
   * @returns {SseEvent|undefined}
   */
  #dispatch() {
    const data = this.dataLines.join('\n')
    const eventName = this.eventName
    this.eventName = undefined
    this.dataLines = []
    if (data.length === 0) return undefined
    return { ...(eventName === undefined ? {} : { event: eventName }), data }
  }
}
