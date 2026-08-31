/**
 * Balance snapshot types shared by the service and HTTP API.  No token ever
 * appears in these shapes.
 *
 * @module dsh-provider-openai-subscription/balance/types
 */

/**
 * @typedef {object} BalanceWindow
 * @property {string} id
 * @property {string} label
 * @property {number} usedPercent
 * @property {number} remainingPercent
 * @property {number} [windowSeconds]
 * @property {number} [resetsAt]
 * @property {number} [resetAfterSeconds]
 * @property {boolean} exhausted
 */

/**
 * @typedef {object} BalanceSnapshot
 * @property {'ready'|'stale'|'unauthenticated'|'error'} status
 * @property {string} [plan]
 * @property {number} [fetchedAt]
 * @property {BalanceWindow[]} windows
 * @property {Array<{id: string, label: string, usedPercent: number, remainingPercent: number, resetsAt?: number}>} additionalLimits
 * @property {boolean} [allowed]
 * @property {boolean} [limitReached]
 * @property {string} [errorCode]
 * @property {string} [message]
 */
