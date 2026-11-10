import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import Papa from 'papaparse'
import { XMLValidator } from 'fast-xml-parser'
import { crossCheckSites, loadStudyPack, siteVerdict, type LoadedSitePack } from '@/lib/network/aggregator'
import { issueProtocol, locateStudyRepo, PROTOCOL_PATHS, type IssuedProtocol } from '@/lib/strategus/protocol'
import { auditResultFiles, readResultsZip, RDMS_FILE, type ResultFile } from '@/lib/strategus/results'
import { parseAnalysisSpecification } from '@/lib/strategus/spec'
import { buildStudyPack, type PackInputFile } from '@/lib/studypack/builder'
import { SLOT_BY_ID, type SlotId } from '@/lib/studypack/slots'
import { datasetFiles, DEFINE_XML_VERSIONS, type DefineXmlVersion } from '@/lib/cdisc/defineXml'
import type { DatasetJson11 } from '@/lib/cdisc/datasetJson'
import { readXpt } from '@/lib/cdisc/xpt'
import { xmllint } from '@/lib/cdisc/xmllint.testutil'
import { buildRegulatoryExport, listResultTables, type RegulatoryExport, type SiteRow } from './regulatory'

/**
 * Builds the submission package (define.xml, Dataset-JSON, audit report) and the draft reviewer's guide
 * from a real Strategus run on Eunomia (r/tests/eunomia/run-eunomia.R): the study folder is issued as a
 * protocol, the zipResults() ZIP and the files next to it are sealed as a site StudyPack as Site Mode
 * does, and the pack goes through the aggregator and the Export Hub code. Skipped unless
 * STUDYSTUDIO_EUNOMIA points to the folder that script wrote; define.xml is also checked against the CDISC
 * schemas when STUDYSTUDIO_DEFINE_XSD is set. The outputs are written to <folder>/submission for review
 * (e.g. with Pinnacle 21). The strategus-eunomia workflow runs it.
 */
const out = process.env.STUDYSTUDIO_EUNOMIA
const schemas = process.env.STUDYSTUDIO_DEFINE_XSD
const STUDY = 'EUNOMIA_GIBLEED'
const SITE = 'Eunomia'
const MIN = 5

describe.skipIf(!out)('submission package from a real Strategus run on Eunomia', () => {
  let protocol: IssuedProtocol
  let results: ResultFile[]
  let site: LoadedSitePack
  let rows: SiteRow[]
  const exports = {} as Record<DefineXmlVersion, RegulatoryExport>
  /** SAS V5 transport files of the result tables (the Export Hub default, without the copies of the specification). */
  const xpts = {} as Record<DefineXmlVersion, RegulatoryExport>

  beforeAll(async () => {
    const file = (...p: string[]) => new Uint8Array(readFileSync(path.join(out!, ...p)))
    const repo = locateStudyRepo(['inst/analysisSpecifications.json', 'ExecuteAnalyses.R', 'renv.lock'].map((p) => ({ path: p, bytes: file('study', p) })))
    protocol = await issueProtocol(repo, { studyId: STUDY, studyTitle: 'Strategus test study on Eunomia GiBleed', sponsor: 'OHDSI Study Studio CI', cdmVersion: '5.3', minCellCount: MIN })

    // Site Mode: the zipResults() ZIP, plus run_record.json and executionSettings.json from the results folder.
    results = await readResultsZip(file('results.zip'))
    const audits = auditResultFiles(results, { minCellCount: MIN })
    const slot = (id: SlotId, bytes: Uint8Array): PackInputFile => ({ path: SLOT_BY_ID[id].path, role: SLOT_BY_ID[id].role, originalName: SLOT_BY_ID[id].label, bytes })
    const pack = await buildStudyPack({
      studyId: STUDY,
      studyTitle: protocol.config.studyTitle,
      siteId: SITE,
      cdmVersion: '5.3',
      minCellCount: MIN,
      exportedMinCellCount: MIN,
      protocolBytes: protocol.configBytes,
      files: [
        slot('analysisSpecifications', protocol.files[PROTOCOL_PATHS.analysisSpecifications]),
        slot('executeAnalyses', protocol.files[PROTOCOL_PATHS.executeAnalyses]),
        slot('renvLock', protocol.files[PROTOCOL_PATHS.renvLock]),
        slot('executionSettings', file('results', 'executionSettings.json')),
        slot('runRecord', file('results', 'run_record.json')),
        ...results.map((r) => ({ path: `results/${r.path}`, role: 'result' as const, originalName: r.path, bytes: r.bytes, audit: audits.get(r.path) })),
      ],
    })
    site = await loadStudyPack(pack.zipName, await pack.zipBlob.arrayBuffer())
    const { config } = protocol
    const cross = crossCheckSites([site], config.expectedHashes, config.protectedSections, [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)])
    const verdict = siteVerdict(site, cross, config.studyId, [site])
    rows = [{ site, verdict, adopted: verdict.recommended === 'adopt' }]

    const dir = path.join(out!, 'submission')
    const save = async (name: string, x: RegulatoryExport) => {
      const v = path.join(dir, name)
      mkdirSync(path.join(v, 'datasets'), { recursive: true })
      writeFileSync(path.join(v, 'define.xml'), x.defineXml)
      for (const [p, d] of Object.entries(x.datasets)) writeFileSync(path.join(v, p), d)
      writeFileSync(path.join(v, 'audit_report.md'), x.markdown)
      writeFileSync(path.join(v, 'adrg.md'), x.reviewersGuide.markdown)
      writeFileSync(path.join(v, 'adrg.html'), x.reviewersGuide.html)
      writeFileSync(path.join(v, x.zipName), new Uint8Array(await x.zipBlob.arrayBuffer()))
    }
    const resultsOnly = listResultTables([site]).filter((t) => !t.specification).map((t) => t.key)
    for (const version of DEFINE_XML_VERSIONS) {
      const base = { studyId: STUDY, studyTitle: config.studyTitle, config, cross, rows, defineXmlVersion: version, agency: 'FDA' as const }
      exports[version] = await buildRegulatoryExport(base)
      await save(`define-${version}`, exports[version])
      xpts[version] = await buildRegulatoryExport({ ...base, datasetFormat: 'xpt', tables: resultsOnly })
      await save(`define-${version}-xpt`, xpts[version])
    }
    const conformance = Object.fromEntries(DEFINE_XML_VERSIONS.flatMap((v) => [[v, exports[v].conformance], [`${v}-xpt`, xpts[v].conformance]]))
    writeFileSync(path.join(dir, 'issues.json'), JSON.stringify(conformance, null, 2) + '\n')
  }, 120_000)

  const csvs = () => results.filter((r) => r.path.endsWith('.csv') && !r.path.endsWith('/' + RDMS_FILE))

  it('seals the Eunomia results into a verified site pack that the aggregator adopts', () => {
    expect(csvs().length).toBeGreaterThan(10)
    expect(site.integrity.status).toBe('verified')
    expect(rows[0].verdict.reasons).toEqual([])
    expect(rows[0].adopted).toBe(true)
    // The Export Hub leaves out the copies of the specification by default; every table is exported below.
    expect(listResultTables([site]).filter((t) => t.specification).map((t) => t.table)).toEqual(expect.arrayContaining(['cg_cohort_definition', 'cm_analysis']))
  })

  it.each(DEFINE_XML_VERSIONS)('turns every result table into a dataset described in define.xml %s', (version) => {
    const x = exports[version]
    const dec = new TextDecoder()
    const expected = csvs().map((r) => ({ name: r.path, rows: Papa.parse(dec.decode(r.bytes), { header: true, skipEmptyLines: true }).data.length }))
    expect(x.tables.map((t) => `${t.module}/${t.sourceTable}.csv`).sort()).toEqual(expected.map((e) => e.name).sort())
    for (const t of x.tables) expect(t.rows.length, `${t.module}/${t.sourceTable}`).toBe(expected.find((e) => e.name === `${t.module}/${t.sourceTable}.csv`)!.rows)
    expect(Object.keys(x.datasets)).toHaveLength(x.tables.length)
    for (const t of x.tables) expect(x.defineXml).toContain(`<ItemGroupDef OID="IG.${t.name}"`)
    // Every dataset row has a value or null for each column, in the declared type.
    for (const [p, text] of Object.entries(x.datasets)) {
      const d = JSON.parse(text as string) as DatasetJson11
      expect(d.records, p).toBe(d.rows.length)
      for (const r of d.rows) {
        expect(r, p).toHaveLength(d.columns.length)
        r.forEach((v, i) => {
          const c = d.columns[i]
          const ok = v === null || (c.dataType === 'string' ? typeof v === 'string' : c.dataType === 'integer' ? Number.isInteger(v) : Number.isFinite(v))
          expect(ok, `${p} ${c.name} (${c.dataType}): ${JSON.stringify(v)}`).toBe(true)
        })
      }
    }
  })

  it.each(DEFINE_XML_VERSIONS)('define.xml %s passes the built-in checks and the CDISC schema, with Dataset-JSON and with XPT', (version) => {
    for (const x of [exports[version], xpts[version]]) {
      expect(XMLValidator.validate(x.defineXml)).toBe(true)
      expect(x.conformance.issues).toEqual([])
      if (schemas) expect(xmllint(schemas, version, x.defineXml)).toBe('')
    }
  })

  it.each(DEFINE_XML_VERSIONS)('writes the result tables as XPT with the same values (define.xml %s)', (version) => {
    const x = xpts[version]
    expect(x.tables.map((t) => t.sourceTable)).not.toContain('cg_cohort_definition')
    expect(Object.keys(x.datasets)).toHaveLength(x.tables.length)
    for (const t of x.tables) {
      const file = datasetFiles(x.tables, 'xpt').get(t.name)!
      const d = readXpt(x.datasets[file.path] as Uint8Array)
      expect(d.name).toBe(file.sasName)
      expect(d.rows, t.name).toHaveLength(t.rows.length)
      expect(d.variables.map((v) => (v.type === 'char' ? 'string' : 'number')), t.name).toEqual(t.columns.map((c) => (c.dataType === 'string' ? 'string' : 'number')))
      d.rows.forEach((r, ri) =>
        r.forEach((v, ci) => {
          const want = t.rows[ri][ci]
          // IBM doubles have no negative zero: -0 reads back as 0.
          expect(v, `${t.name}[${ri}].${t.columns[ci].name}`).toEqual(typeof want === 'string' ? want.trimEnd() || null : want === 0 ? 0 : want)
        }),
      )
    }
  })

  it('fills the draft reviewer\'s guide from the Eunomia study', () => {
    const g = exports['2.1'].reviewersGuide.markdown
    expect(g).not.toMatch(/undefined|NaN|\[object Object\]/)
    for (const h of ['## 1. Introduction', '### 1.2 Study Data Standards and Dictionary Inventory', '## 2. Protocol Description', '### 5.2 Analysis Datasets', '### 6.2 Issues Summary', '### 7.1 Description', '### 7.2 Analysis Datasets Programs'])
      expect(g).toContain(h)
    const spec = parseAnalysisSpecification(new TextDecoder().decode(protocol.files[PROTOCOL_PATHS.analysisSpecifications]))
    expect(spec.cohorts.length).toBeGreaterThan(0)
    for (const c of spec.cohorts) expect(g).toContain(`| ${c.cohortId} | `)
    for (const m of spec.modules) expect(g).toContain(`\`${m}\``)
    if (spec.cohortMethod) expect(g).toContain('Comparative cohort analyses (CohortMethod):')
    for (const t of exports['2.1'].tables) expect(g).toContain(`| ${t.rows.length} | `)
    const lock = JSON.parse(new TextDecoder().decode(protocol.files[PROTOCOL_PATHS.renvLock])) as { Packages: Record<string, { Version: string }> }
    for (const p of ['Strategus', 'CohortMethod']) expect(g).toContain(`| ${p} | ${lock.Packages[p].Version} |`)
    expect(g).toContain(`\`${protocol.config.expectedHashes[PROTOCOL_PATHS.analysisSpecifications]}\``)
    expect(g).toContain(`| ${SITE} | adopted |`)
    expect(exports['2.1'].reviewersGuide.html).toContain('<strong class="todo">[TO BE COMPLETED:')
    // Not sealed in the package; the site's evidence is.
    expect(exports['2.1'].manifest.files.map((f) => f.path).some((p) => /review|adrg/i.test(p))).toBe(false)
    expect(exports['2.1'].manifest.files.map((f) => f.path)).toContain(`sites/${SITE}/manifest.json`)
  })
})
