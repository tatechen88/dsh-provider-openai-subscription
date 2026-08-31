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
 * @param {object} options
 * @param {string} options.model
 * @param {string} [options.system]
 * @param {Array<{role: string, content: Array<{type: string, text?: string, toolCallId?: string, content?: Array<{type: string, text?: string}>, isError?: boolean}>}>} options.messages
 * @param {Array<{name: string, description: string, parameters: Record<string, unknown>}>} [options.tools]
 * @param {number} [options.maxTokens]
 * @param {string} [options.reasoningEffort]
 * @param {boolean} [options.stream]
 * @returns {Record<string, unknown>}
 */
export function buildResponsesRequest({ model, system, messages = [], tools = [], maxTokens, reasoningEffort, stream = true }) {
  const input = messages.map((message) => mapMessage(message)).filter((item) => item !== undefined)
  const body = {
    model,
    ...(system === undefined || system.length === 0 ? {} : { instructions: system }),
    input,
    stream,
  }
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }
  if (maxTokens !== undefined && Number.isFinite(maxTokens) && maxTokens > 0) {
    body.max_output_tokens = maxTokens
  }
  if (reasoningEffort !== undefined && reasoningEffort.length > 0) {
    body.reasoning = { effort: reasoningEffort }
  }
  return body
}

/**
 * Map one DSH message to a Responses input item.
 * @param {object} message
 * @returns {Record<string, unknown>|undefined}
 */
function mapMessage(message) {
  if (message.role === 'system') return undefined
  if (message.role === 'assistant') {
    const text = contentText(message.content)
    const toolCalls = contentToolCalls(message.content)
    if (text !== undefined) {
      return { role: 'assistant', content: [{ type: 'output_text', text }] }
    }
    if (toolCalls.length > 0) {
      return { role: 'assistant', content: toolCalls.map((call) => ({ type: 'output_text', text: call.arguments ?? '' })) }
    }
    return undefined
  }
  // user / tool-result
  const blocks = message.content ?? []
  const items = []
  for (const block of blocks) {
    if (block.type === 'text') {
      items.push({ type: 'input_text', text: block.text })
    } else if (block.type === 'tool-result') {
      const output = contentText(block.content ?? []) ?? ''
      items.push({ type: 'function_call_output', call_id: block.toolCallId, output, ...(block.isError === true ? { is_error: true } : {}) })
    }
  }
  if (items.length === 0) return undefined
  return { role: 'user', content: items }
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

/**
 * Extract tool call blocks.
 * @param {Array<{type: string, name?: string, arguments?: string}>} content
 * @returns {Array<{type: string, name: string, arguments: string}>}
 */
export function contentToolCalls(content) {
  return content
    .filter((block) => block.type === 'tool-call')
    .map((block) => ({ type: 'function_call', name: block.name ?? '', arguments: block.arguments ?? '' }))
}
