import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkRunRecord, runRecordHashes, type RunRecordReport } from './runRecord'
import { readResultsZip } from './results'

/**
 * Checks the run record of a real Strategus run on Eunomia (r/tests/eunomia/run-eunomia.R) with this
 * implementation. Skipped unless STUDYSTUDIO_EUNOMIA points to the folder that script wrote; the
 * strategus-eunomia workflow runs both.
 */
const out = process.env.STUDYSTUDIO_EUNOMIA
const walk = (d: string, pre = ''): string[] => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n), `${pre}${n}/`) : [`${pre}${n}`]))

describe.skipIf(!out)('run record of a real Strategus run on Eunomia', () => {
  const study = (p: string) => readFileSync(path.join(out!, 'study', p))
  const inputs = () => ({
    'definitions/analysisSpecifications.json': study('inst/analysisSpecifications.json'),
    'code/ExecuteAnalyses.R': study('ExecuteAnalyses.R'),
    'code/renv.lock': study('renv.lock'),
  })
  const check = async (files: Record<string, Uint8Array>): Promise<RunRecordReport> =>
    checkRunRecord({
      bytes: readFileSync(path.join(out!, 'results', 'run_record.json')),
      regulatory: true,
      hashes: await runRecordHashes(files),
      renvLockText: study('renv.lock').toString('utf8'),
    })
  const diagnostics = () => JSON.parse(readFileSync(path.join(out!, 'diagnostics.json'), 'utf8'))

  it('matches the results folder after a full run and a skipCompletedTasks re-run', async () => {
    const results = path.join(out!, 'results')
    const files: Record<string, Uint8Array> = inputs()
    for (const p of walk(results)) {
      if (p === 'executionSettings.json') files['code/executionSettings.json'] = readFileSync(path.join(results, p))
      else if (p.endsWith('.csv')) files[`results/${p}`] = readFileSync(path.join(results, p))
    }
    const r = await check(files)
    console.log(JSON.stringify({ diagnostics: diagnostics(), last: r.last, results: { ...r.results, matched: r.results.matched }, environment: r.environment, issues: r.issues }, null, 2))
    expect(r.runs).toBe(2)
    expect(r.last?.status).toBe('completed')
    expect(r.inputs.map((i) => i.status)).toEqual(['match', 'match', 'match'])
    expect(r.results.recorded).toBeGreaterThan(10)
    expect(r.results).toMatchObject({ mismatched: [], notRecorded: [], stale: [] })
    expect(r.results.matched).toBe(r.results.recorded)
    expect(r.environment.mismatches).toEqual([])
    expect(r.issues).toEqual([])
  })

  it('records each module: run in the first run, skipped as completed in the re-run', () => {
    const [first, second] = diagnostics().modules as { module: string; status: string; skippedAsCompleted: boolean }[][]
    expect(first.map((m) => [m.module, m.status])).toEqual([['CohortGeneratorModule', 'SUCCESS'], ['CohortMethodModule', 'SUCCESS']])
    expect(second.every((m) => m.status === 'SKIPPED' && m.skippedAsCompleted)).toBe(true)
  })

  it('loads the module packages in the recorded session', () => {
    expect(diagnostics().loadedHades).toEqual(expect.arrayContaining(['Strategus', 'CohortGenerator', 'CohortMethod', 'Cyclops', 'FeatureExtraction', 'DatabaseConnector']))
  })

  it('matches the CSVs from Strategus::zipResults(), which leaves out run_record.json and executionSettings.json', async () => {
    const entries: string[] = diagnostics().zipEntries
    expect(entries.some((e) => e.endsWith('run_record.json') || e.endsWith('executionSettings.json'))).toBe(false)
    const files: Record<string, Uint8Array> = inputs()
    for (const f of await readResultsZip(readFileSync(path.join(out!, 'results.zip')))) files[`results/${f.path}`] = f.bytes
    files['code/executionSettings.json'] = readFileSync(path.join(out!, 'results', 'executionSettings.json'))
    const r = await check(files)
    expect(r.results).toMatchObject({ mismatched: [], notRecorded: [], stale: [] })
    expect(r.issues).toEqual([])
  })
})
