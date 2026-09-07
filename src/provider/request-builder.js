/**
 * OpenAI Responses API request builder.
 *
 * Translates DSH GenerateOptions into the ChatGPT Codex Responses request
 * body.  This module is pure and does no I/O.
 *
 * @module dsh-provider-openai-subscription/provider/request-builder
 */

/**
 * Build a Responses API request body.
 *
 * Tool calls and tool results are emitted as TOP-LEVEL input items
 * (`function_call` / `function_call_output`), not nested inside a role
 * message's content array — the ChatGPT Codex endpoint rejects the nested
 * form.
 *
 * @param {object} options
 * @param {string} options.model
 * @param {string} [options.system]
 * @param {Array<{role: string, content: Array<{type: string, text?: string, id?: string, name?: string, arguments?: string, toolCallId?: string, content?: Array<{type: string, text?: string}>, isError?: boolean}>}>} options.messages
 * @param {Array<{name: string, description: string, parameters: Record<string, unknown>}>} [options.tools]
 * @param {number} [options.maxTokens]
 * @param {string} [options.reasoningEffort]
 * @param {boolean} [options.stream]
 * @returns {Record<string, unknown>}
 */
export function buildResponsesRequest({ model, system, messages = [], tools = [], maxTokens, reasoningEffort, stream = true }) {
  void maxTokens // the codex endpoint rejects max_output_tokens; DSH's cap is dropped
  const input = messages.flatMap((message) => mapMessageItems(message))
  const body = {
    model,
    ...(system === undefined || system.length === 0 ? {} : { instructions: system }),
    input,
    stream,
    // The ChatGPT Codex backend only accepts store: false.
    store: false,
  }
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }
  if (reasoningEffort !== undefined && reasoningEffort.length > 0) {
    body.reasoning = { effort: reasoningEffort }
  }
  return body
}

/**
 * Map one DSH message to zero or more top-level Responses input items.
 * @param {object} message
 * @returns {Array<Record<string, unknown>>}
 */
function mapMessageItems(message) {
  if (message.role === 'system' || message.role === 'developer') return []
  if (message.role === 'assistant') return mapAssistantMessage(message)
  return mapUserMessage(message)
}

/**
 * Map an assistant message: text becomes an output_text role item, each tool
 * call becomes a top-level `function_call` item.
 * @param {object} message
 * @returns {Array<Record<string, unknown>>}
 */
function mapAssistantMessage(message) {
  const items = []
  const textBlocks = (message.content ?? []).filter((block) => block.type === 'text')
  if (textBlocks.length > 0) {
    items.push({
      role: 'assistant',
      content: textBlocks.map((block) => ({ type: 'output_text', text: block.text ?? '' })),
    })
  }
  for (const block of message.content ?? []) {
    if (block.type !== 'tool-call') continue
    const { callId, itemId } = splitToolCallId(block.id)
    items.push({
      type: 'function_call',
      call_id: callId,
      ...(itemId !== undefined ? { id: itemId } : {}),
      name: block.name ?? '',
      arguments: block.arguments ?? '',
    })
  }
  return items
}

/**
 * Map a user (or tool-result) message: text becomes input_text, tool results
 * become top-level `function_call_output` items.
 * @param {object} message
 * @returns {Array<Record<string, unknown>>}
 */
function mapUserMessage(message) {
  const items = []
  const inputBlocks = []
  for (const block of message.content ?? []) {
    if (block.type === 'text') {
      inputBlocks.push({ type: 'input_text', text: block.text ?? '' })
    } else if (block.type === 'tool-result') {
      if (inputBlocks.length > 0) {
        items.push({ role: 'user', content: inputBlocks.splice(0, inputBlocks.length) })
      }
      const { callId } = splitToolCallId(block.toolCallId)
      items.push({ type: 'function_call_output', call_id: callId, output: contentText(block.content ?? []) ?? '' })
    }
  }
  if (inputBlocks.length > 0) {
    items.push({ role: 'user', content: inputBlocks })
  }
  return items
}

/**
 * Split a DSH tool-call id into the Responses `call_id` and optional item id.
 * The id is `callId|itemId` when an item id exists, else just `callId`.
 * @param {string|undefined} id
 * @returns {{callId: string, itemId: string|undefined}}
 */
function splitToolCallId(id) {
  if (typeof id !== 'string' || id.length === 0) return { callId: '', itemId: undefined }
  const separator = id.indexOf('|')
  if (separator === -1) return { callId: id, itemId: undefined }
  const callId = id.slice(0, separator)
  const itemId = id.slice(separator + 1)
  return { callId, itemId: itemId.length > 0 ? itemId : undefined }
}

/**
 * Extract text from content blocks.
 * @param {Array<{type: string, text?: string}>} content
 * @returns {string|undefined}
 */
export function contentText(content) {
  const text = content.find((block) => block.type === 'text')
  return text && typeof text.text === 'string' ? text.text : undefined
}
