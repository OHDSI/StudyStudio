import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkRunRecord, runRecordHashes } from './runRecord'

/**
 * Checks a run record written by R (r/tests/cross-check.R) with this implementation. Skipped unless
 * STUDYSTUDIO_R_RECORD points to the folder that script wrote; CI runs both.
 */
const folder = process.env.STUDYSTUDIO_R_RECORD
const root = path.resolve(__dirname, '../../..')
const walk = (d: string, pre = ''): string[] => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n), `${pre}${n}/`) : [`${pre}${n}`]))

describe.skipIf(!folder)('run record written by R', () => {
  it('matches the inputs and every result as hashed by TypeScript', async () => {
    expect(existsSync(path.join(folder!, 'run_record.json'))).toBe(true)
    const files: Record<string, Uint8Array> = {
      'definitions/analysisSpecifications.json': readFileSync(path.join(root, 'samples/study-repo/inst/analysisSpecifications.json')),
      'code/ExecuteAnalyses.R': readFileSync(path.join(root, 'samples/study-repo/ExecuteAnalyses.R')),
      'code/renv.lock': readFileSync(path.join(root, 'samples/study-repo/renv.lock')),
    }
    for (const p of walk(folder!)) {
      if (p === 'executionSettings.json') files['code/executionSettings.json'] = readFileSync(path.join(folder!, p))
      else if (p.endsWith('.csv')) files[`results/${p}`] = readFileSync(path.join(folder!, p))
    }
    const r = checkRunRecord({
      bytes: readFileSync(path.join(folder!, 'run_record.json')),
      regulatory: true,
      hashes: await runRecordHashes(files),
      renvLockText: readFileSync(path.join(root, 'samples/study-repo/renv.lock'), 'utf8'),
    })
    expect(r.inputs.map((i) => [i.key, i.status])).toEqual([['analysisSpecifications', 'match'], ['executionScript', 'match'], ['renvLock', 'match']])
    expect(r.results).toMatchObject({ recorded: 12, matched: 12, mismatched: [], notRecorded: [], stale: [] })
    expect(r.last?.status).toBe('completed')
    // Strategus is not installed for this check, and the R version may differ from renv.lock.
    expect(r.issues.map((i) => i.code).filter((c) => c !== 'no-strategus' && c !== 'env-r')).toEqual([])
  })
})
