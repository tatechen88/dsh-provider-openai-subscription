/**
 * Minimal SemVer comparison for the readiness report.
 *
 * The rescue CLI is standalone and zero-dependency, so this does not pull in a
 * semver package; it covers exactly what an `engines.dsh` range needs, with the
 * precedence rules that decide the verdict:
 *
 * - numeric fields compare numerically, left to right;
 * - a prerelease sorts **before** its own release (`0.2.0-rc.1 < 0.2.0`);
 * - inside a prerelease, numeric identifiers sort below alphanumeric ones, and
 *   a shorter set of equal fields sorts first (`0.1.6-alpha < 0.1.6-alpha.1`).
 *
 * @module dsh-provider-openai-subscription/version-range
 */

/**
 * Parse `[v]major.minor.patch[-prerelease][+build]`.
 * @param {unknown} value
 * @returns {{numbers: number[], prerelease: string[]}|null} null when unparsable.
 */
export function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value.trim())
  if (match === null) return null
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/**
 * SemVer precedence between two parsed versions.
 * @param {{numbers: number[], prerelease: string[]}} left
 * @param {{numbers: number[], prerelease: string[]}} right
 * @returns {-1|0|1}
 */
export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] < right.numbers[index] ? -1 : 1
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/**
 * Whether one version satisfies a whitespace-separated comparator range.
 *
 * Only the operators a declared `engines.dsh` can contain are supported; an
 * unparsable version, range, or clause answers `null` (unknown) rather than
 * `false`, so an unreadable harness is never reported as a mismatch.
 *
 * @param {string} version
 * @param {string} range
 * @returns {boolean|null}
 */
export function satisfiesRange(version, range) {
  const parsed = parseVersion(version)
  if (parsed === null || typeof range !== 'string') return null
  const clauses = range.trim().split(/\s+/).filter((clause) => clause.length > 0)
  if (clauses.length === 0) return null
  for (const clause of clauses) {
    const match = /^(>=|<=|>|<|=)?(.+)$/.exec(clause)
    if (match === null) return null
    const target = parseVersion(match[2])
    if (target === null) return null
    const order = compareVersions(parsed, target)
    const satisfied = match[1] === '>=' ? order >= 0
      : match[1] === '<=' ? order <= 0
        : match[1] === '>' ? order > 0
          : match[1] === '<' ? order < 0
            : order === 0
    if (!satisfied) return false
  }
  return true
}
