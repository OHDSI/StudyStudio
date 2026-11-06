import { readFileSync, readdirSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { checkRunRecord, recordedPackPaths, runRecordReasonCode, parseRunRecord, redactRunRecord, runRecordHashes, RUN_RECORD_PACK_PATH, WITHHELD } from './runRecord'
import { auditResultFiles, findResultsSideFiles, collectRdms, auditOptionsFor } from './results'
import { remediateCsvText } from '@/lib/audit/cellAuditor'
import { buildStudyPack, type PackInputFile } from '@/lib/studypack/builder'
import { SLOT_BY_ID, guessSlot } from '@/lib/studypack/slots'
import { evaluateEvidence, judgeEvidence } from '@/lib/studypack/evidence'

const root = path.resolve(__dirname, '../../..')
const samples = path.join(root, 'samples')
const enc = new TextEncoder()
const dec = new TextDecoder()
const read = (...p: string[]) => new Uint8Array(readFileSync(path.join(...p)))
const walk = (d: string, pre = ''): string[] => readdirSync(d).flatMap((n) => (statSync(path.join(d, n)).isDirectory() ? walk(path.join(d, n), `${pre}${n}/`) : [`${pre}${n}`]))

/** A site's files keyed by StudyPack path, from an expanded results folder written by ExecuteAnalyses.R. */
function siteFromFolder(folder: string) {
  const files: Record<string, Uint8Array> = {
    'definitions/analysisSpecifications.json': read(samples, 'study-repo/inst/analysisSpecifications.json'),
    'code/ExecuteAnalyses.R': read(samples, 'study-repo/ExecuteAnalyses.R'),
    'code/renv.lock': read(samples, 'study-repo/renv.lock'),
  }
  for (const p of walk(folder)) {
    const b = read(folder, p)
    if (p === 'run_record.json') files[RUN_RECORD_PACK_PATH] = b
    else if (p === 'executionSettings.json') files['code/executionSettings.json'] = b
    else if (p.endsWith('.csv')) files[`results/${p}`] = b
  }
  return files
}
const clean = () => siteFromFolder(path.join(samples, 'site/strategus_results_Site_A'))
const renvLockText = () => readFileSync(path.join(samples, 'study-repo/renv.lock'), 'utf8')

async function check(files: Record<string, Uint8Array>, opts: { regulatory?: boolean; originals?: Record<string, Uint8Array>; declaredModified?: string[] } = {}) {
  return checkRunRecord({ bytes: files[RUN_RECORD_PACK_PATH], regulatory: opts.regulatory ?? true, hashes: await runRecordHashes(files, opts.originals), declaredModified: opts.declaredModified, renvLockText: renvLockText() })
}

describe('run record', () => {
  it('matches the inputs and every result file of the sample run', async () => {
    const r = await check(clean())
    expect(r.issues).toEqual([])
    expect(r.inputs.map((i) => i.status)).toEqual(['match', 'match', 'match'])
    expect(r.results.recorded).toBe(12) // 11 CSVs + executionSettings.json
    expect(r.results.matched).toBe(12)
    expect(r.environment.checked).toBe(6)
  })

  it('flags a result changed after the run, and one the run did not write', async () => {
    const files = clean()
    files['results/CohortMethodModule/cm_result.csv'] = enc.encode(dec.decode(files['results/CohortMethodModule/cm_result.csv']).replace(',3.12,', ',1.12,'))
    files['results/CohortMethodModule/cm_extra.csv'] = enc.encode('a\n1\n')
    const r = await check(files)
    expect(r.results.mismatched).toEqual(['results/CohortMethodModule/cm_result.csv'])
    expect(r.results.notRecorded).toEqual(['results/CohortMethodModule/cm_extra.csv'])
    expect(r.issues.map((i) => [i.code, i.severity])).toEqual([['results-changed', 'block'], ['results-unrecorded', 'block']])
    // In a standard study the same findings are warnings.
    expect((await check(files, { regulatory: false })).issues.every((i) => i.severity === 'warn')).toBe(true)
  })

  it('flags a run that used another analysis specification or edited protected code', async () => {
    const files = clean()
    files['definitions/analysisSpecifications.json'] = enc.encode('{"attr_class":"AnalysisSpecifications","other":true}')
    files['code/ExecuteAnalyses.R'] = enc.encode(dec.decode(files['code/ExecuteAnalyses.R']) + '\n# edited\n')
    const r = await check(files)
    expect(r.inputs.filter((i) => i.status === 'mismatch').map((i) => i.key)).toEqual(['analysisSpecifications', 'executionScript'])
    expect(r.issues.filter((i) => i.severity === 'block')).toHaveLength(2)
  })

  it('compares the whole script when it has no protected marker (pinned as a whole file)', async () => {
    const files = clean()
    const script = enc.encode('library(Strategus)\nrecordStrategusRun(Strategus::execute(spec, settings, cd), "results")\n')
    files['code/ExecuteAnalyses.R'] = script
    const rec = JSON.parse(dec.decode(files[RUN_RECORD_PACK_PATH]))
    rec.runs[0].inputs.executionScript = { file: 'run.R', sha256: createHash('sha256').update(script).digest('hex'), protectedSha256: null }
    files[RUN_RECORD_PACK_PATH] = enc.encode(JSON.stringify(rec))
    const r = await check(files)
    expect(r.inputs.find((i) => i.key === 'executionScript')).toMatchObject({ status: 'match', wholeFile: true })
    expect(r.issues).toEqual([])

    files['code/ExecuteAnalyses.R'] = enc.encode(dec.decode(script) + '# edited\n')
    const changed = await check(files)
    expect(changed.issues.map((i) => [i.code, i.message])).toEqual([['input-executionScript', 'The run used a different ExecuteAnalyses.R than the one sealed in the pack']])
  })

  it('flags results left by an earlier run unless an earlier run with the same inputs wrote them', async () => {
    const files = clean()
    const rec = JSON.parse(dec.decode(files[RUN_RECORD_PACK_PATH]))
    const first = rec.runs[0]
    const stalePath = 'CohortMethodModule/cm_result.csv'
    const second = { ...first, startedAt: '2026-11-03T10:00:00+09:00', finishedAt: '2026-11-03T11:00:00+09:00' }
    // executionSettings.json is saved by the script just before the wrapped call: never stale.
    second.results = first.results.map((f: { path: string }) => ({ ...f, modifiedAt: f.path === stalePath || f.path === 'executionSettings.json' ? '2026-11-01T00:00:00+09:00' : '2026-11-03T10:30:00+09:00' }))
    // Only the second run: the old file is not vouched for.
    files[RUN_RECORD_PACK_PATH] = enc.encode(JSON.stringify({ ...rec, runs: [second] }))
    const alone = await check(files)
    expect(alone.results.stale).toEqual([`results/${stalePath}`])
    expect(alone.issues.map((i) => [i.code, i.severity])).toEqual([['results-stale', 'block']])
    // A re-run of some modules: the first, completed run wrote that file with the same content.
    files[RUN_RECORD_PACK_PATH] = enc.encode(JSON.stringify({ ...rec, runs: [first, second] }))
    expect((await check(files)).issues).toEqual([])
    // The file system's clock is used when recorded: a share 10 minutes behind the R machine is fine.
    const skewed = { ...second, startedAtFileSystem: '2026-11-03T09:50:00+09:00', results: second.results.map((f: { path: string }) => ({ ...f, modifiedAt: f.path === stalePath ? '2026-11-01T00:00:00+09:00' : '2026-11-03T10:20:00+09:00' })) }
    files[RUN_RECORD_PACK_PATH] = enc.encode(JSON.stringify({ ...rec, runs: [{ ...skewed, results: skewed.results.map((f: { path: string }) => (f.path === stalePath ? { ...f, modifiedAt: '2026-11-03T09:55:00+09:00' } : f)) }] }))
    expect((await check(files)).results.stale).toEqual([])
    // An earlier run that failed later on still counts (Strategus skipCompletedTasks re-runs only what is left)...
    files[RUN_RECORD_PACK_PATH] = enc.encode(JSON.stringify({ ...rec, runs: [{ ...first, status: 'failed' }, second] }))
    expect((await check(files)).results.stale).toEqual([])
    // ...but not one that used another analysis specification.
    const otherSpec = { ...first, inputs: { ...first.inputs, analysisSpecifications: { file: 'a.json', sha256: '0'.repeat(64) } } }
    files[RUN_RECORD_PACK_PATH] = enc.encode(JSON.stringify({ ...rec, runs: [otherSpec, second] }))
    expect((await check(files)).results.stale).toEqual([`results/${stalePath}`])
  })

  it('compares loaded HADES packages with renv.lock', async () => {
    const files = clean()
    const rec = JSON.parse(dec.decode(files[RUN_RECORD_PACK_PATH]))
    rec.runs[0].packages.CohortMethod = '5.9.0'
    files[RUN_RECORD_PACK_PATH] = enc.encode(JSON.stringify(rec))
    const r = await check(files)
    expect(r.environment.mismatches).toEqual([{ package: 'CohortMethod', locked: '6.0.0', loaded: '5.9.0', hades: true }])
    expect(r.issues.map((i) => i.code)).toEqual(['env-hades'])
  })

  it('flags a recorded run that did not load Strategus (nothing was executed)', async () => {
    const files = clean()
    const rec = JSON.parse(dec.decode(files[RUN_RECORD_PACK_PATH]))
    delete rec.runs[0].packages.Strategus
    files[RUN_RECORD_PACK_PATH] = enc.encode(JSON.stringify(rec))
    expect((await check(files)).issues.map((i) => [i.code, i.severity])).toEqual([['no-strategus', 'block']])
    expect(runRecordReasonCode({ code: 'no-strategus' })).toBe('INTEGRITY')
  })

  it('blocks a failed last run, a missing record in regulatory studies, and an invalid one', async () => {
    const files = clean()
    const rec = JSON.parse(dec.decode(files[RUN_RECORD_PACK_PATH]))
    rec.runs.push({ ...rec.runs[0], status: 'failed', errorClass: 'simpleError' })
    files[RUN_RECORD_PACK_PATH] = enc.encode(JSON.stringify(rec))
    expect((await check(files)).issues.map((i) => i.code)).toContain('run-failed')

    const none = clean()
    delete none[RUN_RECORD_PACK_PATH]
    expect((await check(none)).issues.map((i) => [i.code, i.severity])).toEqual([['missing', 'block']])
    expect((await check(none, { regulatory: false })).issues).toEqual([])

    none[RUN_RECORD_PACK_PATH] = enc.encode('{"format":"something-else","runs":[]}')
    expect((await check(none)).issues[0].code).toBe('invalid')
  })

  it('checks masked results against their originals at the site, and withholds their hashes in the pack', async () => {
    const folder = path.join(samples, 'site/with_violations/strategus_results_Site_A_with_violations')
    const site = siteFromFolder(folder)
    // Mask like the app does, keeping the originals in memory.
    const resultList = Object.entries(site).filter(([p]) => p.startsWith('results/')).map(([p, b]) => ({ path: p.slice(8), bytes: b }))
    const audits = auditResultFiles(resultList, { minCellCount: 5 })
    const rdms = collectRdms(resultList)
    const originals: Record<string, Uint8Array> = {}
    for (const f of resultList) {
      if (audits.get(f.path)!.passed) continue
      originals[`results/${f.path}`] = f.bytes
      site[`results/${f.path}`] = enc.encode(remediateCsvText(dec.decode(f.bytes), auditOptionsFor(f.path, rdms, { minCellCount: 5 }), 'negative'))
    }
    const masked = Object.keys(originals)
    expect(masked.length).toBeGreaterThan(0)

    // Site: masked files are compared through their originals.
    const atSite = await check(site, { originals })
    expect(atSite.issues).toEqual([])
    expect(atSite.results.matched).toBe(atSite.results.recorded)

    // Without the originals the masked files would look changed.
    expect((await check(site)).results.mismatched.sort()).toEqual(masked.sort())

    // Packed copy: no plain hash of any unmasked original.
    const red = redactRunRecord(site[RUN_RECORD_PACK_PATH], masked)!
    expect(red.withheld).toBe(masked.length)
    const packed = dec.decode(red.bytes)
    const originalHashes = (await runRecordHashes(originals)).file
    for (const h of Object.values(originalHashes)) expect(packed).not.toContain(h)
    const withheldEntries = parseRunRecord(red.bytes).runs[0].results!.filter((f) => f.withheld === WITHHELD)
    expect(withheldEntries).toHaveLength(masked.length)
    expect(withheldEntries.every((f) => f.modifiedAt && !f.sha256 && !f.sizeBytes)).toBe(true)

    // Coordinator: withheld entries are fine when the manifest declares the file as masked.
    const atCoordinator = { ...site, [RUN_RECORD_PACK_PATH]: red.bytes }
    const ok = await check(atCoordinator, { declaredModified: masked })
    expect(ok.issues).toEqual([])
    expect(ok.results.withheld).toBe(masked.length)
    expect((await check(atCoordinator)).issues.map((i) => i.code)).toEqual(['withheld-undeclared'])
  })

  it('is redacted inside buildStudyPack, with the original under a salted commitment', async () => {
    const files: PackInputFile[] = [
      { path: 'results/M/t.csv', role: 'result', originalName: 't.csv', bytes: enc.encode('n\n-5\n'), original: enc.encode('n\n3\n'), modification: { kind: 'small-cell-masking', rule: 'r', counts: {}, reason: 'r' } },
    ]
    const record = enc.encode(JSON.stringify({ format: 'studypack-run-record/1', runs: [{ status: 'completed', results: [{ path: 'M/t.csv', sha256: 'a'.repeat(64), sizeBytes: 5 }] }] }))
    files.push({ path: RUN_RECORD_PACK_PATH, role: 'evidence', originalName: 'run_record.json', bytes: record })
    const pack = await buildStudyPack({ studyId: 'S', siteId: 'X', cdmVersion: '5.4', minCellCount: 5, files })
    const zip = await JSZip.loadAsync(await pack.zipBlob.arrayBuffer())
    const sealed = await zip.file(`${pack.rootDir}/${RUN_RECORD_PACK_PATH}`)!.async('string')
    expect(sealed).not.toContain('a'.repeat(64))
    expect(sealed).toContain(WITHHELD)
    expect(pack.manifest.files.find((f) => f.path === RUN_RECORD_PACK_PATH)!.originalCommitment).toMatch(/^[0-9a-f]{64}$/)
    expect(pack.retention.originals.map((o) => o.kind).sort()).toEqual(['run-record-redaction', 'small-cell-masking'])
  })

  it('makes regulatory evidence refuse to seal when the record was not checked', () => {
    const e = evaluateEvidence({ config: { assurance: 'regulatory' } as never, files: {} })
    expect(e.runRecord).toBeUndefined()
    expect(judgeEvidence(e).blockers).toContain('Run record: not checked (no file hashes were supplied to the evidence evaluation)')
  })
})

describe('run record files', () => {
  it('classifies blocking issues as protocol deviation or integrity', () => {
    for (const code of ['input-analysisSpecifications', 'input-executionScript', 'input-renvLock', 'env-hades']) expect(runRecordReasonCode({ code })).toBe('PROTOCOL_DEVIATION')
    for (const code of ['missing', 'invalid', 'run-failed', 'input-renvLock-unrecorded', 'results-changed', 'results-unrecorded', 'withheld-undeclared']) expect(runRecordReasonCode({ code })).toBe('INTEGRITY')
  })

  it('maps recorded paths to StudyPack paths', () => {
    const m = recordedPackPaths(['CohortMethodModule/cm_result.csv', 'top.csv', 'executionSettings.json', 'strategus-log.txt'].map((path) => ({ path })))
    expect(Object.fromEntries(m)).toEqual({
      'CohortMethodModule/cm_result.csv': 'results/CohortMethodModule/cm_result.csv',
      'top.csv': 'results/_root/top.csv',
      'executionSettings.json': 'code/executionSettings.json',
    })
  })

  it('lines up when R was given a parent of the results folder, also with a work folder beside it', async () => {
    const files = clean()
    const rec = JSON.parse(dec.decode(files[RUN_RECORD_PACK_PATH]))
    const run = rec.runs[0]
    const moved = run.results.map((f: { path: string }) => ({ ...f, path: `results/Site_A/${f.path}` }))
    // A work folder at the same depth whose CSVs normalise to the same paths with other content.
    const work = run.results.filter((f: { path: string }) => f.path.endsWith('.csv')).map((f: { path: string; sha256: string }) => ({ ...f, path: `work/Site_A/${f.path}`, sha256: 'f'.repeat(64) }))
    run.results = [...work, ...moved]
    files[RUN_RECORD_PACK_PATH] = enc.encode(JSON.stringify(rec))
    const r = await check(files)
    expect(r.issues).toEqual([])
    expect(r.results.matched).toBe(12)
  })

  it('is found next to the module folders and has its own slot', () => {
    const side = findResultsSideFiles([
      { name: 'parent/Site_A/run_record.json', bytes: enc.encode('1') },
      { name: 'parent/Site_A/CohortMethodModule/run_record.json', bytes: enc.encode('2') },
      { name: 'parent/Site_A/executionSettings.json', bytes: enc.encode('3') },
    ])
    expect(dec.decode(side.runRecord!.bytes)).toBe('1')
    expect(dec.decode(side.executionSettings!.bytes)).toBe('3')
    expect(guessSlot('run_record.json')).toBe('runRecord')
    expect(SLOT_BY_ID.runRecord.path).toBe(RUN_RECORD_PACK_PATH)
  })

  it('the sample ExecuteAnalyses.R carries r/recordStrategusRun.R verbatim below the protected marker', () => {
    const fn = readFileSync(path.join(root, 'r/recordStrategusRun.R'), 'utf8')
    const script = readFileSync(path.join(samples, 'templates/ExecuteAnalyses.R'), 'utf8')
    const marker = script.indexOf('DO NOT MODIFY BELOW THIS POINT')
    expect(marker).toBeGreaterThan(0)
    expect(script.indexOf(fn)).toBeGreaterThan(marker)
    expect(script).toMatch(/recordStrategusRun\(\s*Strategus::execute\(/)
  })
})
