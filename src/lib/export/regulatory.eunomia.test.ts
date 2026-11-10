import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
 * Builds the submission package (define.xml, Dataset-JSON / XPT, audit report) and the draft reviewer's
 * guide from real Strategus runs on Eunomia (r/tests/eunomia/run-eunomia.R): the first site's study folder
 * is issued as a protocol; each site's zipResults() ZIP and the files next to it are sealed as a site
 * StudyPack as Site Mode does (the second site, site_b, ran on a reduced copy of Eunomia with its own
 * INPUTS block), and the packs go through the aggregator and the Export Hub code. Skipped unless
 * STUDYSTUDIO_EUNOMIA points to the folder that script wrote; define.xml is also checked against the CDISC
 * schemas when STUDYSTUDIO_DEFINE_XSD is set. The outputs are written to <folder>/submission for review
 * (e.g. with Pinnacle 21). The strategus-eunomia workflow runs it.
 */
const out = process.env.STUDYSTUDIO_EUNOMIA
const schemas = process.env.STUDYSTUDIO_DEFINE_XSD
const STUDY = 'EUNOMIA_GIBLEED'
const MIN = 5
/** The sites the script ran; site_b is absent when only the first site was run. */
const SITES = out ? [{ id: 'Eunomia', dir: out }, { id: 'Eunomia_B', dir: path.join(out, 'site_b') }].filter((s) => existsSync(path.join(s.dir, 'results.zip'))) : []

describe.skipIf(!out)('submission package from a real Strategus run on Eunomia', () => {
  let protocol: IssuedProtocol
  /** Result files per site, as dropped in Site Mode. */
  const results = new Map<string, ResultFile[]>()
  const packs: LoadedSitePack[] = []
  let rows: SiteRow[]
  const exports = {} as Record<DefineXmlVersion, RegulatoryExport>
  /** SAS V5 transport files of the result tables (the Export Hub default, without the copies of the specification). */
  const xpts = {} as Record<DefineXmlVersion, RegulatoryExport>

  beforeAll(async () => {
    const file = (...p: string[]) => new Uint8Array(readFileSync(path.join(out!, ...p)))
    const repo = locateStudyRepo(['inst/analysisSpecifications.json', 'ExecuteAnalyses.R', 'renv.lock'].map((p) => ({ path: p, bytes: file('study', p) })))
    protocol = await issueProtocol(repo, { studyId: STUDY, studyTitle: 'Strategus test study on Eunomia GiBleed', sponsor: 'OHDSI Study Studio CI', cdmVersion: '5.3', minCellCount: MIN })

    // Site Mode: the zipResults() ZIP, plus run_record.json and executionSettings.json from the results folder,
    // and the site's own ExecuteAnalyses.R (its INPUTS block may differ from the protocol's).
    const slot = (id: SlotId, bytes: Uint8Array): PackInputFile => ({ path: SLOT_BY_ID[id].path, role: SLOT_BY_ID[id].role, originalName: SLOT_BY_ID[id].label, bytes })
    for (const s of SITES) {
      const at = (...p: string[]) => new Uint8Array(readFileSync(path.join(s.dir, ...p)))
      const files = await readResultsZip(at('results.zip'))
      results.set(s.id, files)
      const audits = auditResultFiles(files, { minCellCount: MIN })
      const pack = await buildStudyPack({
        studyId: STUDY,
        studyTitle: protocol.config.studyTitle,
        siteId: s.id,
        cdmVersion: '5.3',
        minCellCount: MIN,
        exportedMinCellCount: MIN,
        protocolBytes: protocol.configBytes,
        files: [
          slot('analysisSpecifications', protocol.files[PROTOCOL_PATHS.analysisSpecifications]),
          slot('executeAnalyses', at('study', 'ExecuteAnalyses.R')),
          slot('renvLock', protocol.files[PROTOCOL_PATHS.renvLock]),
          slot('executionSettings', at('results', 'executionSettings.json')),
          slot('runRecord', at('results', 'run_record.json')),
          ...files.map((r) => ({ path: `results/${r.path}`, role: 'result' as const, originalName: r.path, bytes: r.bytes, audit: audits.get(r.path) })),
        ],
      })
      packs.push(await loadStudyPack(pack.zipName, await pack.zipBlob.arrayBuffer()))
    }
    const { config } = protocol
    const cross = crossCheckSites(packs, config.expectedHashes, config.protectedSections, [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)])
    rows = packs.map((site) => {
      const verdict = siteVerdict(site, cross, config.studyId, packs)
      return { site, verdict, adopted: verdict.recommended === 'adopt' }
    })

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
    const resultsOnly = listResultTables(packs).filter((t) => !t.specification).map((t) => t.key)
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

  const dec = new TextDecoder()
  const csvs = (siteId: string) => results.get(siteId)!.filter((r) => r.path.endsWith('.csv') && !r.path.endsWith('/' + RDMS_FILE))
  const csvRows = (r: ResultFile) => Papa.parse<Record<string, string>>(dec.decode(r.bytes), { header: true, skipEmptyLines: true }).data

  it('seals each site\'s Eunomia results into a verified pack that the aggregator adopts', () => {
    for (const s of SITES) expect(csvs(s.id).length, s.id).toBeGreaterThan(10)
    for (const r of rows) {
      expect(r.site.integrity.status, r.site.siteId).toBe('verified')
      expect(r.verdict.reasons, r.site.siteId).toEqual([])
      expect(r.adopted, r.site.siteId).toBe(true)
    }
    // The Export Hub leaves out the copies of the specification by default; every table is exported below.
    expect(listResultTables(packs).filter((t) => t.specification).map((t) => t.table)).toEqual(expect.arrayContaining(['cg_cohort_definition', 'cm_analysis']))
  })

  it.skipIf(SITES.length < 2)('adopts a second site that ran its own INPUTS block on different data', () => {
    const script = (i: number) => packs[i].files[PROTOCOL_PATHS.executeAnalyses]
    expect(dec.decode(script(1))).not.toBe(dec.decode(script(0)))
    expect(rows.map((r) => r.adopted)).toEqual([true, true])
    // Different data: own database ID, fewer subjects in the cohorts.
    const meta = (id: string) => csvRows(csvs(id).find((r) => r.path.endsWith('/database_meta_data.csv'))!)
    expect(meta(SITES[1].id)[0].database_id).not.toBe(meta(SITES[0].id)[0].database_id)
    const subjects = (id: string) => Object.fromEntries(csvRows(csvs(id).find((r) => r.path.endsWith('/cg_cohort_count.csv'))!).map((r) => [r.cohort_id, Number(r.cohort_subjects)]))
    const [a, b] = SITES.map((s) => subjects(s.id))
    expect(Object.keys(a).some((c) => b[c] !== undefined && b[c] < a[c])).toBe(true)
  })

  it.each(DEFINE_XML_VERSIONS)('turns every result table into a dataset described in define.xml %s', (version) => {
    const x = exports[version]
    // Rows per site and table, as in each site's CSV.
    const expected = new Map<string, Map<string, number>>()
    for (const s of SITES)
      for (const r of csvs(s.id)) {
        if (!expected.has(r.path)) expected.set(r.path, new Map())
        expected.get(r.path)!.set(s.id, csvRows(r).length)
      }
    expect(x.tables.map((t) => `${t.module}/${t.sourceTable}.csv`).sort()).toEqual([...expected.keys()].sort())
    for (const t of x.tables) {
      const name = `${t.module}/${t.sourceTable}.csv`
      const perSite = new Map<string, number>()
      for (const r of t.rows) perSite.set(String(r[0]), (perSite.get(String(r[0])) ?? 0) + 1)
      for (const [siteId, n] of expected.get(name)!) expect(perSite.get(siteId) ?? 0, `${name} ${siteId}`).toBe(n)
      expect(t.rows.length, name).toBe([...expected.get(name)!.values()].reduce((a, b) => a + b, 0))
      // Concatenated across sites, the declared keys (SITE_ID first) still identify each record.
      // (Tables whose data model declares no key have SITE_ID alone and are not checked.)
      const keys = t.columns.map((c, i) => (c.primaryKey ? i : -1)).filter((i) => i >= 0)
      if (keys.length > 1) {
        const seen = new Set(t.rows.map((r) => JSON.stringify(keys.map((i) => r[i]))))
        expect(seen.size, `${name}: duplicate key ${t.columns.filter((c) => c.primaryKey).map((c) => c.name).join(', ')}`).toBe(t.rows.length)
      }
    }
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
    for (const s of SITES) expect(g).toContain(`| ${s.id} | adopted |`)
    expect(exports['2.1'].reviewersGuide.html).toContain('<strong class="todo">[TO BE COMPLETED:')
    // Not sealed in the package; the site's evidence is.
    expect(exports['2.1'].manifest.files.map((f) => f.path).some((p) => /review|adrg/i.test(p))).toBe(false)
    for (const s of SITES) expect(exports['2.1'].manifest.files.map((f) => f.path)).toContain(`sites/${s.id}/manifest.json`)
  })
})
