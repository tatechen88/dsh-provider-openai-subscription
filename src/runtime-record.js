/**
 * The record one activation leaves behind: what this process actually registered.
 *
 * There is no interface to look at any more, so the question "are the tools
 * live in this deployment?" has to be answerable from outside the process. This
 * file is the answer, and the rescue CLI prints it.
 *
 * It is written twice: once when the registrations are in place, and once when
 * they are gone. A record with a `stoppedAt` is history; one without says the
 * plugin is running now. Both halves matter — a stale record that looks live is
 * worse than no record at all.
 *
 * Writes are serialized through one queue and each uses its own temporary file.
 * Teardown fires record writes from disposers that nobody awaits, so two writes
 * can overlap; sharing one temp filename let them interleave into a corrupt
 * record, and whichever rename landed last won — which could be the write from
 * *before* the stop, leaving a disabled plugin looking live. A queue keeps the
 * last write the last to land, and a unique temp name keeps every write whole.
 *
 * @module dsh-provider-openai-subscription/runtime-record
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { runtimeRecordPath } from './state.js'

/** Writes are applied in call order, one at a time. */
let queue = Promise.resolve()

/** Distinguishes temporary files within one process. */
let temporaryCounter = 0

/**
 * Write the record atomically, best effort, in call order.
 *
 * A diagnostic must never be the reason an activation fails: every failure here
 * is swallowed, because the plugin's real work does not depend on this file.
 *
 * @param {object} record - what to record; `startedAt` is the caller's clock.
 * @param {string} [home] - DSH home; injectable so tests can aim it.
 * @returns {Promise<boolean>} whether it landed.
 */
export function writeRuntimeRecord(record, home) {
  const attempt = queue.then(async () => {
    const path = runtimeRecordPath(home)
    temporaryCounter += 1
    const temporary = `${path}.${process.pid}.${temporaryCounter}.tmp`
    try {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(temporary, `${JSON.stringify(record, undefined, 2)}\n`, 'utf8')
      await rename(temporary, path)
      return true
    } catch {
      return false
    }
  })
  // A failed write must not poison the queue for the next one.
  queue = attempt.catch(() => {})
  return attempt
}
