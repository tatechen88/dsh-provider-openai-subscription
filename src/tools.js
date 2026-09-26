/**
 * The agent-facing tools: the only entry point a chat can reach.
 *
 * With no browser half, a tool call is how a person asks the running harness to
 * sign in, check, or sign out. That makes the descriptions part of the product:
 * they are what a model reads before deciding to call, and a vague one produces
 * a login nobody completes. Each description therefore says what the call does,
 * what the human must do, and what happens if they take their time.
 *
 * The definitions are returned as option bags and shaped by the harness's own
 * `defineTool`, resolved at activation: this plugin is installed from a local
 * path, so it must not import a harness package it cannot resolve, and a
 * deployment without that package simply gets no tools rather than a failed
 * activation.
 *
 * @module dsh-provider-openai-subscription/tools
 */

/** Prefix every tool shares, so the family is obvious in a tool list. */
const PREFIX = 'openai_subscription'

/**
 * The tool options this plugin registers.
 *
 * @param {object} input
 * @param {object} input.operations - see {@link module:dsh-provider-openai-subscription/operations}.
 * @returns {object[]} option bags for the harness `defineTool`.
 */
export function toolOptions({ operations }) {
  return [
    {
      name: `${PREFIX}_status`,
      description: 'Report the OpenAI subscription sign-in state: whether a ChatGPT credential is stored, which account it belongs to, when it expires, and whether a sign-in is currently waiting for the user to finish in a browser. Read-only; call it before and after a login instead of guessing.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
      },
      execute: () => operations.status(),
      presentCall: () => ({ card: 'generic', title: 'OpenAI subscription status', kind: 'read' }),
    },
    {
      name: `${PREFIX}_login`,
      description: 'Start signing in to a ChatGPT subscription so its models can be used. Returns a link the user must open in their own browser; the call waits briefly for them to finish and then reports either the finished sign-in or that it is still pending. A pending sign-in keeps running, so continue with the status tool rather than starting a second one.',
      parameters: {
        method: {
          type: 'string',
          description: "How the user signs in. 'oauth' (default) opens a link in their browser; 'device' shows a code they enter on another device, for machines with no browser.",
        },
        wait_seconds: {
          type: 'number',
          description: 'How long to wait for the sign-in to finish before reporting it pending. Defaults to 60.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
      },
      execute: (args) => operations.login({
        ...(typeof args?.method === 'string' ? { method: args.method } : {}),
        ...(typeof args?.wait_seconds === 'number' ? { waitMs: Math.max(1, Math.min(600, args.wait_seconds)) * 1000 } : {}),
      }),
      presentCall: () => ({ card: 'generic', title: 'Sign in to ChatGPT', kind: 'other' }),
    },
    {
      name: `${PREFIX}_logout`,
      description: 'Forget the stored ChatGPT credential and stop any sign-in that is still waiting. The subscription itself is untouched — this only removes the local record, and signing in again is a new login.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, undefined, 2) }],
      },
      execute: () => operations.logout(),
      presentCall: () => ({ card: 'generic', title: 'Sign out of ChatGPT', kind: 'other' }),
    },
  ]
}
