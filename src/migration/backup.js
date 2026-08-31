import { randomBytes, scrypt as scryptCallback, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { pluginStateDir } from '../state.js'

const scrypt = promisify(scryptCallback)

/** Legacy Provider and credential identifiers owned by the existing pi-ai route. */
export const LEGACY_PROVIDER_ID = 'openai-codex'
export const LEGACY_CREDENTIAL_KEY = 'llm-pi-ai/openai-codex'

/**
 * Describe whether the legacy Provider and credential record are present.
 * @param {object} input
 * @param {object} input.llm
 * @param {() => Array<{id: string}>} input.llm.listProviders
 * @param {object} input.credentials
 * @param {(key: string) => Promise<{configured: boolean, kind?: string, writable: boolean}>} input.credentials.describeRecord
 * @returns {Promise<{providerPresent: boolean, credentialPresent: boolean, credentialKind?: string}>}
 */
export async function inspectLegacy({ llm, credentials }) {
  const providerPresent = typeof llm?.listProviders === 'function'
    && llm.listProviders().some(entry => entry.id === LEGACY_PROVIDER_ID)
  const info = await credentials.describeRecord(LEGACY_CREDENTIAL_KEY)
  return {
    providerPresent,
    credentialPresent: info.configured === true,
    ...(info.kind === undefined ? {} : { credentialKind: info.kind }),
  }
}

/**
 * Encrypt a legacy credential record for a reversible migration backup.
 * @param {unknown} record
 * @param {string} password
 * @returns {Promise<{algorithm: string, salt: string, iv: string, tag: string, ciphertext: string}>}
 */
export async function encryptLegacyRecord(record, password) {
  if (typeof password !== 'string' || password.length < 12) {
    throw new TypeError('backup password must contain at least 12 characters')
  }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await scrypt(password, salt, 32)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record), 'utf8'), cipher.final()])
  return {
    algorithm: 'scrypt/aes-256-gcm',
    salt: salt.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  }
}

/**
 * Write one encrypted legacy credential backup without exposing its payload.
 * @param {object} input
 * @param {object} input.credentials
 * @param {(key: string) => Promise<unknown|undefined>} input.credentials.readRecord
 * @param {string} input.password
 * @param {string} [input.directory]
 * @returns {Promise<{backupId: string, path: string}>}
 */
/**
 * Decrypt one backup payload after authenticating its password and metadata.
 * @param {{algorithm: string, salt: string, iv: string, tag: string, ciphertext: string}} encrypted
 * @param {string} password
 * @returns {Promise<unknown>}
 */
export async function decryptLegacyRecord(encrypted, password) {
  if (encrypted?.algorithm !== 'scrypt/aes-256-gcm') throw new Error('unsupported backup algorithm')
  const key = await scrypt(password, Buffer.from(encrypted.salt, 'base64url'), 32)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64url'))
  const plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64url')), decipher.final()]).toString('utf8')
  return JSON.parse(plaintext)
}

/**
 * Restore a legacy credential record from a backup file.
 * @param {object} input
 * @param {object} input.credentials
 * @param {(key: string, mutate: (current: unknown) => Promise<unknown>) => Promise<unknown>} input.credentials.modifyRecord
 * @param {string} input.path
 * @param {string} input.password
 * @param {(path: string) => Promise<string>} input.readFile
 * @returns {Promise<void>}
 */
export async function restoreLegacyCredential({ credentials, path, password, readFile }) {
  const backup = JSON.parse(await readFile(path))
  if (backup?.provider !== LEGACY_PROVIDER_ID || backup?.credentialKey !== LEGACY_CREDENTIAL_KEY) {
    throw new Error('backup does not belong to the legacy OpenAI OAuth provider')
  }
  const record = await decryptLegacyRecord(backup.encrypted, password)
  await credentials.modifyRecord(LEGACY_CREDENTIAL_KEY, async () => record)
}

export async function backupLegacyCredential({ credentials, password, directory = join(pluginStateDir(), 'openai-subscription-backups') }) {
  const record = await credentials.readRecord(LEGACY_CREDENTIAL_KEY)
  if (record === undefined) throw new Error('legacy OpenAI OAuth credential is not configured')
  const encrypted = await encryptLegacyRecord(record, password)
  const backupId = `openai-codex-${Date.now()}-${randomBytes(4).toString('hex')}`
  const path = join(directory, `${backupId}.json`)
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}`
  await writeFile(temp, `${JSON.stringify({ schemaVersion: 1, backupId, provider: LEGACY_PROVIDER_ID, credentialKey: LEGACY_CREDENTIAL_KEY, createdAt: new Date().toISOString(), encrypted }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, path)
  return { backupId, path }
}
