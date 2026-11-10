import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { XMLValidator } from 'fast-xml-parser'
import { crossCheckSites, loadStudyPack, siteVerdict, type LoadedSitePack } from '@/lib/network/aggregator'
import { buildMarkdownReport, buildRegulatoryExport, listResultTables } from './regulatory'
import type { StudyConfig } from '@/types/studypack'

const samples = path.resolve(__dirname, '../../../samples')

describe('network demo end-to-end', () => {
  it('adopts the clean sites and exports a verifiable submission package', async () => {
    const config = JSON.parse(readFileSync(path.join(samples, 'protocol/study_config.json'), 'utf8')) as StudyConfig
    const dir = path.join(samples, 'network')
    const sites = await Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
    const paths = [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)]
    const cross = crossCheckSites(sites, config.expectedHashes, config.protectedSections, paths)
    const rows = sites.map((s) => {
      const verdict = siteVerdict(s, cross, config.studyId, sites)
      return { site: s, verdict, adopted: verdict.recommended === 'adopt' }
    })
    expect(rows.filter((r) => r.adopted).map((r) => r.site.siteId).sort()).toEqual(['Site_A', 'Site_B'])

    const report = buildMarkdownReport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows, generatedAt: 'now' })
    expect(report).toContain('| Site_C |')
    expect(report).toContain('(protected section)')

    const tables = listResultTables(rows.filter((r) => r.adopted).map((r) => r.site))
    expect(tables.map((t) => t.key)).toContain('CohortMethodModule/cm_result')
    expect(tables.find((t) => t.key === 'CohortMethodModule/cm_result')).toMatchObject({ sites: 2, rows: 4 })

    const out = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows })
    expect(XMLValidator.validate(out.defineXml)).toBe(true)
    expect(Object.keys(out.datasets).sort()).toEqual([
      'datasets/cdcohcou.json',
      'datasets/cgcohcou.json',
      'datasets/cmdiasum.json',
      'datasets/cmresult.json',
      'datasets/datmetda.json',
      'datasets/sccsresu.json',
    ])
    const cm = JSON.parse(out.datasets['datasets/cmresult.json'] as string)
    expect(new Set(cm.rows.map((r: unknown[]) => r[0]))).toEqual(new Set(['Site_A', 'Site_B']))
    // HADES-censored counts stay numeric (-5), so the column stays an integer.
    expect(cm.columns.find((c: { name: string }) => c.name === 'TARGET_OUTCOMES').dataType).toBe('integer')
    expect(out.markdown).toContain('Define-XML v2.1 / Dataset-JSON v1.1')

    const zip = await JSZip.loadAsync(await out.zipBlob.arrayBuffer())
    expect(Object.keys(zip.files)).toContain('ACEI_ANGIO_2026-submission/define.xml')

    const xsl = { name: 'define2-1-0.xsl', text: '<?xml version="1.0"?><xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform"/>' }
    const styled = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows, stylesheet: xsl })
    expect(styled.defineXml.split('\n')[1]).toBe('<?xml-stylesheet type="text/xsl" href="define2-1-0.xsl"?>')
    expect(XMLValidator.validate(styled.defineXml)).toBe(true)
    const styledZip = await JSZip.loadAsync(await styled.zipBlob.arrayBuffer())
    expect(await styledZip.file('ACEI_ANGIO_2026-submission/define2-1-0.xsl')!.async('string')).toBe(xsl.text)
    expect(styled.manifest.files.map((f) => f.path)).toContain('define2-1-0.xsl')
    expect((await loadStudyPack(styled.zipName, await styled.zipBlob.arrayBuffer())).integrity.status).toBe('verified')
    const plain = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows, stylesheet: null })
    expect(plain.defineXml).not.toContain('xml-stylesheet')
    expect((await loadStudyPack(out.zipName, await out.zipBlob.arrayBuffer())).integrity.status).toBe('verified')

    // Conformance: no issue from the checks; the validator warning expected by design is listed and explained.
    expect(out.conformance.issues).toEqual([])
    expect(out.conformance.expected.map((e) => e.p21)).toEqual(['DD0139', 'AD0001', 'AD1024', 'AD1026', 'SD0061', 'AD9999'])
    expect(out.standards.ctVersion).toBe('2026-03-27')
    expect(out.defineXml).toContain('PublishingSet="ADaM" Version="2026-03-27"')
    expect(out.markdown).toContain('## Define-XML conformance')
    expect(out.markdown).toContain('**DD0139** (FDA Warning / PMDA Warning; define.xml)')
    expect(out.markdown).toContain('**AD0001** (FDA Reject / PMDA Reject; datasets)')

    // Draft reviewer's guide: filled from the study, with the sponsor's parts marked; not sealed in the package.
    const g = out.reviewersGuide.markdown
    for (const h of ['## 1. Introduction', '### 1.2 Study Data Standards and Dictionary Inventory', '### 5.2 Analysis Datasets', '### 6.2 Issues Summary', '### 7.2 Analysis Datasets Programs'])
      expect(g).toContain(h)
    expect(g).toContain('| CMRESULT | cm_result (CohortMethodModule) | ADAM OTHER |')
    expect(g).toContain('| 1781 | New users of ACE inhibitors (Target) | target (CM), exposure (SCCS) |')
    expect(g).toContain('| DD0139 | define.xml |')
    expect(g).toContain('| AD0001 | datasets | Missing ADSL dataset | FDA Reject / PMDA Reject |')
    expect(g).toContain('| Strategus | 1.6.0 |')
    expect(g).toContain(`\`${config.expectedHashes['definitions/analysisSpecifications.json']}\``)
    expect(g).toContain('- Site_C: Tampering detected (hash mismatch)')
    expect(g).toContain('**[TO BE COMPLETED: study design')
    expect(out.reviewersGuide.html).toContain('<strong class="todo">[TO BE COMPLETED: study design')
    expect(out.manifest.files.map((f) => f.path).some((p) => /review|adrg/i.test(p))).toBe(false)

    // The agency rates issues and is recorded; it does not change define.xml or the datasets.
    const now = new Date('2026-01-02T03:04:05Z')
    const [fda, pmda] = await Promise.all((['FDA', 'PMDA'] as const).map((agency) => buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows, agency, now })))
    expect(pmda.defineXml).toBe(fda.defineXml)
    expect(pmda.datasets).toEqual(fda.datasets)
    expect(pmda.markdown).toContain('validator profile: PMDA (Japan)')
    expect(pmda.markdown).toContain('**DD0139** (Warning; define.xml)')
    expect(pmda.markdown).toContain('**SD0061** (Error; datasets)')
    const ct = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows, ctVersion: '2025-09-26' })
    expect(ct.defineXml).toContain('PublishingSet="ADaM" Version="2025-09-26"')
    await expect(buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows, ctVersion: 'latest' })).rejects.toThrow('not a CDISC package date')

    const subset = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows, tables: ['CohortMethodModule/cm_result'], defineXmlVersion: '2.0', datasetJsonVersion: '1.0' })
    expect(Object.keys(subset.datasets)).toEqual(['datasets/cmresult.json'])
    // Dataset-JSON v1.0 is checked against define.xml too.
    expect(subset.conformance.issues).toEqual([])
    expect(subset.conformance.expected.map((e) => e.p21)).toEqual(['AD0001', 'AD1024', 'AD1026', 'SD0061', 'AD9999'])
    expect(subset.defineXml).toContain('ns/def/v2.0')
    expect(JSON.parse(subset.datasets['datasets/cmresult.json'] as string).datasetJSONVersion).toBe('1.0.0')
  })
})

describe('XPT submission package', () => {
  it('writes the datasets as SAS V5 transport files described by SAS names in define.xml', async () => {
    const { readXpt } = await import('@/lib/cdisc/xpt')
    const { checkDatasetsAgainstDefine } = await import('@/lib/cdisc/defineRules')
    const config = JSON.parse(readFileSync(path.join(samples, 'protocol/study_config.json'), 'utf8')) as StudyConfig
    const dir = path.join(samples, 'network')
    const sites = await Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
    const cross = crossCheckSites(sites, config.expectedHashes, config.protectedSections, [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)])
    const rows = sites.map((s) => {
      const verdict = siteVerdict(s, cross, config.studyId, sites)
      return { site: s, verdict, adopted: verdict.recommended === 'adopt' }
    })
    for (const defineXmlVersion of ['2.1', '2.0'] as const) {
      const out = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows, defineXmlVersion, datasetFormat: 'xpt' })
      expect(Object.keys(out.datasets).sort()).toEqual(['cdcohcou', 'cgcohcou', 'cmdiasum', 'cmresult', 'datmetda', 'sccsresu'].map((n) => `datasets/${n}.xpt`))
      expect(out.defineXml).toContain('Name="CMRESULT" SASDatasetName="CMRESULT"')
      expect(out.defineXml).toContain('xlink:href="datasets/cmresult.xpt"')
      expect(out.defineXml).toMatch(/<ItemDef OID="IT\.CM_RESULT\.TARGET_OUTCOMES" Name="TARGOUTC" SASFieldName="TARGOUTC"/)
      expect(out.conformance.issues).toEqual([])
      expect(checkDatasetsAgainstDefine(out.defineXml, out.datasets)).toEqual([])
      const cm = readXpt(out.datasets['datasets/cmresult.xpt'] as Uint8Array)
      expect(cm.rows.map((r) => r[0])).toEqual(['Site_A', 'Site_A', 'Site_B', 'Site_B'])
      expect(out.standards.datasetFormat).toBe('xpt')
      expect(out.markdown).toContain(`Define-XML v${defineXmlVersion} / SAS V5 transport (XPT)`)
      expect(out.reviewersGuide.markdown).toContain('| SAS Version 5 transport format (XPT) | 5 | Analysis datasets |')
      expect((await loadStudyPack(out.zipName, await out.zipBlob.arrayBuffer())).integrity.status).toBe('verified')
    }
    // A defect in an XPT file is caught like one in Dataset-JSON.
    const out = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows, datasetFormat: 'xpt' })
    const broken = { ...out.datasets, 'datasets/cmresult.xpt': (out.datasets['datasets/cmresult.xpt'] as Uint8Array).slice(0, 400) }
    expect(checkDatasetsAgainstDefine(out.defineXml, broken).map((i) => i.rule)).toEqual(['SS-DSJ-011'])
  })
})

describe('reviewer\'s guide with validator reports', () => {
  it('lists each validator run and what it reported, explaining the findings expected by design', async () => {
    const { p21Workbook } = await import('@/lib/cdisc/p21Report.testutil')
    const { parseP21Report } = await import('@/lib/cdisc/p21Report')
    const { reviewersGuideFor } = await import('./regulatory')
    const config = JSON.parse(readFileSync(path.join(samples, 'protocol/study_config.json'), 'utf8')) as StudyConfig
    const dir = path.join(samples, 'network')
    const sites = await Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
    const cross = crossCheckSites(sites, config.expectedHashes, config.protectedSections, [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)])
    const rows = sites.map((s) => {
      const verdict = siteVerdict(s, cross, config.studyId, sites)
      return { site: s, verdict, adopted: verdict.recommended === 'adopt' }
    })
    const out = await buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows, datasetFormat: 'xpt' })
    const define = parseP21Report('define.xlsx', p21Workbook({ engine: 'PMDA 2411.1', config: 'Define.xml (PMDA)', issues: [['DEFINE', 'DD0139', "Standard 'ADaM' is not referenced", 'Warning', 2]] }))
    const data = parseP21Report(
      'adam.xlsx',
      p21Workbook({
        engine: 'PMDA 2411.1',
        config: 'ADaM-IG 1.3 (PMDA)',
        datasets: ['CMRESULT', 'CGCOHCOU'],
        problems: ['MedDRA not configured'],
        issues: [
          ['GLOBAL', 'AD0001', 'Missing ADSL dataset', 'Reject', 1],
          ['CGCOHCOU', 'AD9999', 'Dataset CGCOHCOU not validated', 'Warning', 1],
          ['CMRESULT', 'AD9999', 'Dataset CMRESULT not validated', 'Warning', 1],
          ['CMRESULT', 'SD1324', 'Define.xml/dataset variable label mismatch', 'Error', 3],
        ],
      }),
    )
    const g = reviewersGuideFor(out.reviewersGuideInput, [define, data]).markdown
    expect(g).toContain('| V1 | Pinnacle 21 (software 1.0.9) | PMDA 2411.1 | Define.xml (PMDA) | define.xml | 2026-03-27 | 2026-11-11T02:06:28+09:00 |')
    expect(g).toContain('| V2 | Pinnacle 21 (software 1.0.9) | PMDA 2411.1 | ADaM-IG 1.3 (PMDA) | 2 dataset(s) with define.xml |')
    expect(g).toContain('Installation notes reported by the validator: MedDRA not configured.')
    expect(g).toMatch(/\| DD0139 \| V1 \| Standard 'ADaM' is not referenced \| Warning \| 2 \| The datasets are aggregated results/)
    expect(g).toMatch(/\| AD0001 \| V2 \| Missing ADSL dataset \| Reject \| 1 \| By design the study collects no subject-level data/)
    expect(g).toContain('| AD9999 | V2 | Dataset dataset not validated (2 datasets) | Warning | 2 |')
    // A finding not expected by design is listed for the sponsor to explain.
    expect(g).toContain('| SD1324 | V2 | Define.xml/dataset variable label mismatch | Error | 3 | **[TO BE COMPLETED: explanation]** |')
    for (const todo of ['validator, version, engine', 'whether the validator was run', 'add every issue reported']) expect(g).not.toContain(todo)
    expect(g).not.toContain('someone')
    // Without reports the guide is the one built at export.
    expect(reviewersGuideFor(out.reviewersGuideInput).markdown).toBe(out.reviewersGuide.markdown)
  })
})

describe('result tables offered for export', () => {
  it('marks the tables that copy the analysis specification', () => {
    const csv = new TextEncoder().encode('a\n1\n')
    const files = Object.fromEntries(
      ['CohortGeneratorModule/cg_cohort_definition', 'CohortGeneratorModule/cg_cohort_count', 'CohortMethodModule/cm_analysis', 'CohortMethodModule/cm_result'].map((k) => [`results/${k}.csv`, csv]),
    )
    const tables = listResultTables([{ files } as unknown as LoadedSitePack])
    expect(tables.filter((t) => t.specification).map((t) => t.table)).toEqual(['cg_cohort_definition', 'cm_analysis'])
    expect(tables.find((t) => t.table === 'cm_result')).toMatchObject({ specification: false, rows: 1 })
  })
})

describe('deterministic export', () => {
  it('produces byte-identical define.xml and Dataset-JSON for the same packs, whatever the drop order', async () => {
    const config = JSON.parse(readFileSync(path.join(samples, 'protocol/study_config.json'), 'utf8')) as StudyConfig
    const dir = path.join(samples, 'network')
    const sites = await Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
    const paths = [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)]
    const build = (order: typeof sites, now: Date) => {
      const cross = crossCheckSites(order, config.expectedHashes, config.protectedSections, paths)
      const rows = order.map((s) => {
        const verdict = siteVerdict(s, cross, config.studyId, order)
        return { site: s, verdict, adopted: verdict.recommended === 'adopt' }
      })
      return buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows, now, stylesheet: null })
    }
    const a = await build(sites, new Date('2026-01-02T03:04:05Z'))
    const b = await build([...sites].reverse(), new Date('2026-01-02T03:04:05Z'))
    expect(b.defineXml).toBe(a.defineXml)
    expect(b.datasets).toEqual(a.datasets)
    // Only the timestamps change with the clock.
    const c = await build(sites, new Date('2027-06-07T08:09:10Z'))
    const stripTs = (s: string) => s.replaceAll('2026-01-02T03:04:05', 'T').replaceAll('2027-06-07T08:09:10', 'T')
    expect(stripTs(c.defineXml)).toBe(stripTs(a.defineXml))
    for (const k of Object.keys(a.datasets)) expect(stripTs(c.datasets[k] as string)).toBe(stripTs(a.datasets[k] as string))
  })
})

describe('disposition audit trail in the submission', () => {
  it('records decisions with reasons and ships the chained log with the package', async () => {
    const { DispositionLog } = await import('@/lib/network/dispositionLog')
    const config = JSON.parse(readFileSync(path.join(samples, 'protocol/study_config.json'), 'utf8')) as StudyConfig
    const dir = path.join(samples, 'network')
    const sites = await Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
    const cross = crossCheckSites(sites, config.expectedHashes, config.protectedSections, [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)])
    const log = new DispositionLog()
    const actor = { name: 'Coordinator', role: 'coordinator', organization: 'Net' }
    const rows = []
    for (const s of sites) {
      const verdict = siteVerdict(s, cross, config.studyId, sites)
      await log.append({ actor, action: 'received', siteId: s.siteId, packSha256: s.zipSha256 })
      await log.append({ actor, action: verdict.recommended, siteId: s.siteId, packSha256: s.zipSha256, from: 'undecided', to: verdict.recommended, recommended: verdict.recommended, reasonCode: verdict.recommended === 'exclude' ? verdict.codes[0] : undefined })
      rows.push({ site: s, verdict, decision: verdict.recommended, adopted: verdict.recommended === 'adopt' })
    }
    await log.append({ actor, action: 'lock', reasonText: 'attested' })
    const excludedC = log.entries.find((e) => e.siteId === 'Site_C' && e.action === 'exclude')!
    expect(excludedC.reasonCode).toBe('INTEGRITY')
    expect(log.entries.find((e) => e.siteId === 'Site_D' && e.action === 'exclude')!.reasonCode).toBe('PROTOCOL_DEVIATION')

    const head = log.headBytes(config.studyId)
    const out = await buildRegulatoryExport({
      studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows,
      disposition: { entries: log.entries, jsonl: log.toJsonl(), headHash: log.headHash, head },
    })
    expect(out.markdown).toContain('## 4. Site disposition')
    expect(out.markdown).toMatch(/Dispositions locked:\*\* yes — by Coordinator/)
    expect(out.markdown).toContain('| Site_C |')
    expect(out.markdown).toContain('## Limitations')
    // The reviewer's guide gives the recorded reason and the lock.
    expect(out.reviewersGuide.markdown).toContain('- Site_C: INTEGRITY')
    expect(out.reviewersGuide.markdown).toMatch(/the dispositions were locked by Coordinator on /)
    const zip = await JSZip.loadAsync(await out.zipBlob.arrayBuffer())
    const names = Object.keys(zip.files)
    const jsonl = await zip.file(names.find((n) => n.endsWith('disposition/disposition_log.jsonl'))!)!.async('string')
    const restored = await DispositionLog.fromJsonl(jsonl, JSON.parse(await zip.file(names.find((n) => n.endsWith('disposition_head.json'))!)!.async('string')))
    expect(restored.headHash).toBe(log.headHash)
    expect(names.some((n) => n.endsWith('sites/Site_A/audit_report.json'))).toBe(true)

    // Regulatory studies: the library itself refuses an export before the lock or with undecided sites.
    const reg = { ...config, assurance: 'regulatory' as const }
    const unlocked = new DispositionLog()
    await unlocked.append({ actor, action: 'note', reasonText: 'not locked' })
    const disp = (l: InstanceType<typeof DispositionLog>) => ({ entries: l.entries, jsonl: l.toJsonl(), headHash: l.headHash, head: l.headBytes(config.studyId) })
    await expect(buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config: reg, cross, rows })).rejects.toThrow(/lock the site dispositions/)
    await expect(buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config: reg, cross, rows, disposition: disp(unlocked) })).rejects.toThrow(/lock the site dispositions/)
    await expect(
      buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config: reg, cross, rows: rows.map((r, i) => (i === 0 ? { ...r, decision: undefined } : r)), disposition: disp(log) }),
    ).rejects.toThrow(/no recorded decision/)
    await expect(buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config: reg, cross, rows, disposition: disp(log) })).resolves.toBeDefined()
  })
})
