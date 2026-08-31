import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupLegacyCredential, encryptLegacyRecord, inspectLegacy, LEGACY_CREDENTIAL_KEY, LEGACY_PROVIDER_ID } from '../src/migration/backup.js'

test('inspectLegacy reports provider and credential without reading payload', async () => {
  const result = await inspectLegacy({
    llm: { listProviders: () => [{ id: LEGACY_PROVIDER_ID }] },
    credentials: { describeRecord: async (key) => {
      assert.equal(key, LEGACY_CREDENTIAL_KEY)
      return { configured: true, kind: 'grant', writable: true }
    } },
  })
  assert.deepEqual(result, { providerPresent: true, credentialPresent: true, credentialKind: 'grant' })
})

test('encryptLegacyRecord rejects short passwords and does not expose plaintext', async () => {
  await assert.rejects(() => encryptLegacyRecord({ access: 'secret' }, 'short'), /at least 12/)
  const encrypted = await encryptLegacyRecord({ access: 'secret' }, 'correct horse battery staple')
  assert.equal(encrypted.algorithm, 'scrypt/aes-256-gcm')
  assert.equal(encrypted.ciphertext.includes('secret'), false)
})

test('backupLegacyCredential writes an encrypted backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-openai-backup-test-'))
  try {
    const result = await backupLegacyCredential({
      directory,
      password: 'correct horse battery staple',
      credentials: { readRecord: async (key) => {
        assert.equal(key, LEGACY_CREDENTIAL_KEY)
        return { kind: 'grant', payload: { access: 'secret', refresh: 'refresh' } }
      } },
    })
    const saved = JSON.parse(await readFile(result.path, 'utf8'))
    assert.equal(saved.provider, LEGACY_PROVIDER_ID)
    assert.equal(saved.credentialKey, LEGACY_CREDENTIAL_KEY)
    assert.equal(saved.encrypted.algorithm, 'scrypt/aes-256-gcm')
    assert.equal(JSON.stringify(saved).includes('secret'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
