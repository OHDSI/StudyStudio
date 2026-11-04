import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAnalysisSpecification } from './spec'
import { inputMinCellCount, protectedSection, protectedSectionHash } from './executeScript'
import { auditResultFiles, normalizeResultPaths, parseRdms, rdmsCountColumns, readResultsZip, summarizeResultsAudit } from './results'
import { issueProtocol, locateStudyRepo, readProtocolFile, protocolZip, unzipRepo } from './protocol'

const samples = path.resolve(__dirname, '../../../samples')
const read = (p: string) => readFileSync(path.join(samples, p))
const enc = new TextEncoder()

describe('analysis specification', () => {
  it('summarizes modules, cohorts, roles and negative controls', () => {
    const s = parseAnalysisSpecification(read('study-repo/inst/analysisSpecifications.json').toString())
    expect(s.modules).toEqual(['CohortGeneratorModule', 'CohortDiagnosticsModule', 'CohortMethodModule', 'SelfControlledCaseSeriesModule'])
    expect(s.negativeControlOutcomes).toBe(5)
    expect(s.cohorts.map((c) => [c.cohortId, c.roles])).toEqual([
      [1781, ['target (CM)', 'exposure (SCCS)']],
      [1782, ['comparator (CM)']],
      [1783, ['outcome (CM)', 'outcome (SCCS)']],
    ])
    expect(s.cohorts[0].expression?.PrimaryCriteria).toBeTruthy()
    expect(s.cohortMethod?.targetComparatorOutcomes[0]).toMatchObject({ targetId: 1781, comparatorId: 1782, outcomesOfInterest: [1783], negativeControlOutcomes: 5, excludedCovariateConcepts: 2 })
    expect(s.sccs?.exposures).toEqual([{ exposureId: 1781, outcomesOfInterest: [1783], negativeControlOutcomes: 5 }])
  })
  it('rejects JSON that is not a Strategus specification', () => {
    expect(() => parseAnalysisSpecification('{"ConceptSets":[]}')).toThrow(/Strategus/)
  })
})

describe('ExecuteAnalyses.R protected section', () => {
  const script = read('study-repo/ExecuteAnalyses.R').toString()
  it('ignores edits to the INPUTS block and catches edits below the marker', async () => {
    const base = await protectedSectionHash(script)
    const inputsEdited = script.replace('databaseName       <- "MY_DATABASE"', 'databaseName <- "HOSPITAL_X"').replace(/\n/g, '\r\n')
    expect(await protectedSectionHash(inputsEdited)).toBe(base)
    expect(await protectedSectionHash(script.replace('minCellCount = minCellCount', 'minCellCount = 0'))).not.toBe(base)
    expect(protectedSection('no marker here')).toBeUndefined()
    expect(inputMinCellCount(script)).toBe(5)
  })
})

describe('Strategus results', () => {
  it('normalizes archive paths to <Module>/<file>.csv', () => {
    const m = normalizeResultPaths(['results/SITE/CohortMethodModule/cm_result.csv', 'results/SITE/DatabaseMetaData/database_meta_data.csv', 'results/SITE/executionSettings.json'])
    expect([...m.values()]).toEqual(['CohortMethodModule/cm_result.csv', 'DatabaseMetaData/database_meta_data.csv'])
  })
  it('reads min_cell_count columns from the results data model', () => {
    const rdms = parseRdms('table_name,column_name,data_type,is_required,primary_key,min_cell_count,deprecated,description\ncm_result,target_subjects,int,Yes,No,Yes,No,x\ncm_result,target_mean,float,No,No,Yes,No,x\ncm_result,rr,float,No,No,No,No,x\n')
    expect(rdmsCountColumns(rdms, 'cm_result')).toEqual(['target_subjects'])
    expect(rdmsCountColumns(rdms, 'other')).toBeUndefined()
  })
  it('flags uncensored exports and passes HADES-censored ones', async () => {
    const clean = summarizeResultsAudit(auditResultFiles(await readResultsZip(read('site/strategus_results_Site_A.zip')), { minCellCount: 5 }))
    expect(clean.passed).toBe(true)
    expect(clean.files).toBe(9)
    const dirtyFiles = await readResultsZip(read('site/strategus_results_Site_A_with_violations.zip'))
    const dirtyAudits = auditResultFiles(dirtyFiles, { minCellCount: 5 })
    const dirty = summarizeResultsAudit(dirtyAudits)
    expect(dirty.passed).toBe(false)
    expect(dirty.failing.map((f) => f.path).sort()).toEqual(['CohortGeneratorModule/cg_cohort_count.csv', 'CohortMethodModule/cm_result.csv', 'SelfControlledCaseSeriesModule/sccs_result.csv'])
    // Only RDMS count columns are scanned: cohort_id 1783 or days are never flagged.
    const cg = dirtyAudits.get('CohortGeneratorModule/cg_cohort_count.csv')!
    expect(cg.sheets[0].countColumnSource).toBe('specification')
    expect(cg.findings.map((f) => f.column)).toEqual(['cohort_entries', 'cohort_subjects'])
  })
})

describe('protocol issuance', () => {
  it('locates the template layout inside a GitHub ZIP and pins section + files', async () => {
    const repo = locateStudyRepo(await unzipRepo(read('study-repo.zip')))
    expect(repo.errors).toEqual([])
    expect(repo.studyName).toBe('ACEI_ANGIO_2026')
    expect(repo.sources.analysisSpecifications).toBe('ACEI_ANGIO_2026-main/inst/analysisSpecifications.json')
    const issued = await issueProtocol(repo, { studyId: 'S', studyTitle: 'T', cdmVersion: '5.4', minCellCount: 5 })
    expect(Object.keys(issued.config.expectedHashes).sort()).toEqual(['code/renv.lock', 'definitions/analysisSpecifications.json'])
    expect(issued.config.protectedSections['code/ExecuteAnalyses.R'].sha256).toBe(await protectedSectionHash(repo.executeText!))
    const back = await readProtocolFile('S_protocol.zip', new Uint8Array(await (await protocolZip(issued)).arrayBuffer()))
    expect(back.errors).toEqual([])
    expect(Object.keys(back.files).sort()).toEqual(['code/ExecuteAnalyses.R', 'code/renv.lock', 'definitions/analysisSpecifications.json'])
  })
  it('supports non-template repositories: any script calling Strategus::execute, pinned whole when unmarked', async () => {
    const spec = read('study-repo/inst/analysisSpecifications.json')
    const repo = locateStudyRepo([
      { path: 'my-study/specs/MyStudyAnalysisSpecification.json', bytes: spec },
      { path: 'my-study/run.R', bytes: enc.encode('cfg <- config::get()\nStrategus::execute(analysisSpecifications = s, executionSettings = e, connectionDetails = c)\n') },
      { path: 'my-study/renv.lock', bytes: read('study-repo/renv.lock') },
      { path: 'my-study/renv/activate.R', bytes: enc.encode('Strategus::execute()') },
    ])
    expect(repo.errors).toEqual([])
    expect(repo.sources.executeAnalyses).toBe('my-study/run.R')
    const issued = await issueProtocol(repo, { studyId: 'S', studyTitle: 'T', cdmVersion: '5.4', minCellCount: 5 })
    expect(issued.config.protectedSections).toEqual({})
    expect(issued.config.expectedHashes['code/ExecuteAnalyses.R']).toMatch(/^[0-9a-f]{64}$/)
  })
  it('reports what is missing', () => {
    expect(locateStudyRepo([]).errors).toHaveLength(3)
  })
})
