/**
 * The agent-facing tools: the only entry point a chat can reach.
 *
 * With no browser half, a tool call is how a person asks the running harness to
 * sign in, check, or sign out. That makes the descriptions part of the product:
 * they are what a model reads before deciding to call, and a vague one produces
 * a login nobody completes. Each description therefore says what the call does,
 * what the human must do, and what happens if they take their time.
 *
 * Every word a person reads comes from the translator the runtime hands in,
 * which resolves the deployment's current language once per activation — the
 * same preference the harness's own Language row writes. A language change
 * therefore takes effect the next time this plugin activates.
 *
 * The definitions are returned as option bags and shaped by the harness's own
 * `defineTool`, resolved at activation: this plugin is installed from a local
 * path, so it must not import a harness package it cannot resolve, and a
 * deployment without that package simply gets no tools rather than a failed
 * activation.
 *
 * @module dsh-provider-openai-subscription/tools
 */

import { lossless } from './lossless.js'
import { translatorFor } from './i18n.js'

/** Prefix every tool shares, so the family is obvious in a tool list. */
const PREFIX = 'openai_subscription'

/**
 * The tool options this plugin registers.
 *
 * @param {object} input
 * @param {object} input.operations - see {@link module:dsh-provider-openai-subscription/operations}.
 * @param {(key: string, params?: Record<string, string|number>) => string} [input.t] -
 *   translator for the words a person reads; English by default, so tests and
 *   headless callers stay deterministic.
 * @returns {object[]} option bags for the harness `defineTool`.
 */
export function toolOptions({ operations, t }) {
  const translate = t ?? translatorFor('en')
  return [
    {
      name: `${PREFIX}_status`,
      description: translate('tool.status.description'),
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
      },
      execute: async () => lossless(await operations.status()),
      presentCall: () => ({ card: 'generic', title: translate('tool.status.title'), kind: 'read' }),
    },
    {
      name: `${PREFIX}_login`,
      description: translate('tool.login.description'),
      parameters: {
        method: {
          type: 'string',
          description: translate('tool.login.param.method'),
        },
        wait_seconds: {
          type: 'number',
          description: translate('tool.login.param.wait_seconds'),
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
      },
      // Every tool result crosses the lossless boundary, this one included: a
      // login reply carries attempt state and credential facts copied straight
      // from live objects, and one `undefined` field in them would fail the
      // whole call.
      execute: async (args) => lossless(await operations.login({
        ...(typeof args?.method === 'string' ? { method: args.method } : {}),
        ...(typeof args?.wait_seconds === 'number' ? { waitMs: Math.max(1, Math.min(600, args.wait_seconds)) * 1000 } : {}),
      })),
      presentCall: () => ({ card: 'generic', title: translate('tool.login.title'), kind: 'other' }),
    },
    {
      name: `${PREFIX}_logout`,
      description: translate('tool.logout.description'),
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
      },
      execute: async () => lossless(await operations.logout()),
      presentCall: () => ({ card: 'generic', title: translate('tool.logout.title'), kind: 'other' }),
    },
    {
      name: `${PREFIX}_quota`,
      description: translate('tool.quota.description'),
      parameters: {
        refresh: {
          type: 'boolean',
          description: translate('tool.quota.param.refresh'),
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
      },
      execute: async (args) => lossless(await operations.quota({ refresh: args?.refresh === true })),
      presentCall: () => ({ card: 'generic', title: translate('tool.quota.title'), kind: 'read' }),
    },
    {
      name: 'usage_meter_report',
      description: translate('tool.usage.description'),
      parameters: {
        scope: {
          type: 'string',
          description: translate('tool.usage.param.scope'),
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
      },
      execute: async (args, exec) => lossless(await operations.usage({
        ...(typeof args?.scope === 'string' ? { scope: args.scope } : {}),
        // The meter keys a session by the id the agent loop sends with each
        // request, which is the session this tool call belongs to.
        ...(typeof exec?.agent?.session?.id === 'string' ? { sessionId: exec.agent.session.id } : {}),
      })),
      presentCall: () => ({ card: 'generic', title: translate('tool.usage.title'), kind: 'read' }),
    },
  ]
}
