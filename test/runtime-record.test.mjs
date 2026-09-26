import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeRuntimeRecord } from '../src/runtime-record.js'
import { runtimeRecordPath } from '../src/state.js'

/**
 * The record is how a client-less deployment answers "what is actually live?".
 * It must be readable, atomic, and — because it is a diagnostic — never able to
 * break the activation that writes it.
 */

test('the record lands where the rescue CLI looks for it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'runtime-record-'))
  try {
    const record = { package: 'dsh-provider-openai-subscription', tools: { registered: ['a', 'b'] } }
    assert.equal(await writeRuntimeRecord(record, home), true)
    const written = JSON.parse(await readFile(runtimeRecordPath(home), 'utf8'))
    assert.equal(written.tools.registered.length, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a write that cannot land reports false instead of throwing', async () => {
  // A file where the state directory should be: mkdir fails, and a diagnostic
  // must not be the reason an activation dies.
  const home = await mkdtemp(join(tmpdir(), 'runtime-record-'))
  try {
    await writeFile(join(home, 'plugin-state'), 'not a directory')
    assert.equal(await writeRuntimeRecord({ package: 'x' }, home), false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
