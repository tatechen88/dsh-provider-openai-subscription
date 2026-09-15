/**
 * The vendors this meter serves, as data.
 *
 * The meter used to know one route at a time: the price book defaulted to
 * DeepSeek's snapshot and the view carried a `deepseek` slice by name, so a
 * third vendor meant another special case in three modules. The routes this
 * meter is responsible for now live in one list — the collector gates on it, the
 * service resolves its price tables from it, and the next vendor is one entry.
 *
 * Each entry is plain data and this module imports nothing, which keeps it at
 * the bottom of the dependency graph: `pricing.js` imports `types.js`, so
 * importing `pricing.js` here would close a cycle. A vendor names its public
 * price table by id instead, and the service joins the id to the table.
 *
 * @module dsh-provider-openai-subscription/usage/vendors
 */

/** Every vendor the meter knows, in display order. */
export const VENDORS = Object.freeze([
  Object.freeze({
    id: 'deepseek',
    providers: Object.freeze(['deepseek-official']),
    /**
     * Id of the public price table this vendor publishes (see `pricing.js`).
     * `undefined` means the route is metered for tokens but has no per-token
     * price of its own.
     */
    priceTableId: 'deepseek-public-2026-09-15',
    /** Account readings the vendor's provider can answer. */
    readings: Object.freeze(['balance']),
  }),
  Object.freeze({
    id: 'zhipu',
    // pi-ai's installed catalog serves Z.AI under two routes. This deployment
    // uses the China coding-plan route; the international `zai` route answers at
    // a different station with its own credential reference, so it becomes its
    // own entry here when a deployment actually uses it.
    providers: Object.freeze(['zai-coding-cn']),
    // A coding plan is billed by the plan, so it publishes no per-token price.
    priceTableId: undefined,
    readings: Object.freeze(['quota', 'balance', 'packages']),
  }),
  Object.freeze({
    id: 'openai-subscription',
    providers: Object.freeze(['openai-subscription']),
    // A ChatGPT subscription is billed by the plan, so it publishes no token
    // price; the account reading is the quota its own balance service serves.
    priceTableId: undefined,
    readings: Object.freeze(['quota']),
  }),
])

/** Provider routes this meter records. Every other route is passed through. */
export const METERED_PROVIDERS = Object.freeze(VENDORS.flatMap((vendor) => vendor.providers))

/**
 * The registry entry owning one wire provider id.
 * @param {string|undefined} providerId
 * @returns {object|undefined}
 */
export function vendorFor(providerId) {
  if (typeof providerId !== 'string' || providerId.length === 0) return undefined
  return VENDORS.find((vendor) => vendor.providers.includes(providerId))
}

/**
 * The vendors that publish a per-token price table.
 * @returns {object[]}
 */
export function pricedVendors() {
  return VENDORS.filter((vendor) => vendor.priceTableId !== undefined)
}
