import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { crossCheckSites, loadStudyPack, siteVerdict } from '@/lib/network/aggregator'
import { buildRegulatoryExport } from '@/lib/export/regulatory'
import type { StudyConfig } from '@/types/studypack'
import { parseAnalysisSpecification } from '@/lib/strategus/spec'
import { collectRdms, readResultsZip } from '@/lib/strategus/results'
import { combineSiteCsvs } from './datasetJson'
import { buildDefineXml, DEFINE_XML_VERSIONS, type DefineInput } from './defineXml'
import { checkDatasetsAgainstDefine, checkDefineXml } from './defineRules'

const samples = path.resolve(__dirname, '../../../samples')

async function networkExport(version: (typeof DEFINE_XML_VERSIONS)[number], datasetJsonVersion: '1.1' | '1.0' = '1.1') {
  const config = JSON.parse(readFileSync(path.join(samples, 'protocol/study_config.json'), 'utf8')) as StudyConfig
  const dir = path.join(samples, 'network')
  const sites = await Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
  const cross = crossCheckSites(sites, config.expectedHashes, config.protectedSections, [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)])
  const rows = sites.map((s) => {
    const verdict = siteVerdict(s, cross, config.studyId, sites)
    return { site: s, verdict, adopted: verdict.recommended === 'adopt' }
  })
  return buildRegulatoryExport({ studyId: config.studyId, studyTitle: config.studyTitle, config, cross, rows, defineXmlVersion: version, datasetJsonVersion, stylesheet: null })
}

describe('define.xml conformance', () => {
  it.each(DEFINE_XML_VERSIONS)('the network demo export (v%s) passes every check', async (version) => {
    const out = await networkExport(version)
    expect(checkDefineXml(out.defineXml)).toEqual([])
    expect(checkDatasetsAgainstDefine(out.defineXml, out.datasets)).toEqual([])
  })
})

async function inputs(): Promise<DefineInput> {
  const files = await readResultsZip(readFileSync(path.join(samples, 'site/strategus_results_Site_A.zip')))
  const rdms = collectRdms(files)
  const dec = new TextDecoder()
  const resultTables = files
    .filter((f) => !f.path.endsWith('resultsDataModelSpecification.csv'))
    .map((f) => {
      const [module, file] = f.path.split('/')
      const table = file.replace(/\.csv$/, '')
      return combineSiteCsvs([{ siteId: 'Site_A', csv: dec.decode(f.bytes) }], { sourceTable: table, module, rdms: rdms.get(module)?.get(table) })
    })
  return {
    studyId: 'S1',
    studyTitle: 'S',
    sourceSystemVersion: '0.1.0',
    cohorts: parseAnalysisSpecification(readFileSync(path.join(samples, 'study-repo/inst/analysisSpecifications.json'), 'utf8')).cohorts,
    resultTables,
    auditReportHref: 'audit_report.html',
  }
}

describe('define.xml conformance for partial inputs', () => {
  const cases: [string, (i: DefineInput) => DefineInput][] = [
    ['no result tables', (i) => ({ ...i, resultTables: [] })],
    ['no cohort count table', (i) => ({ ...i, resultTables: i.resultTables!.filter((t) => !t.columns.some((c) => c.name === 'COHORT_ID')) })],
    ['cohort table without a subject count', (i) => ({ ...i, resultTables: i.resultTables!.map((t) => ({ ...t, columns: t.columns.filter((c) => c.name !== 'COHORT_SUBJECTS') })) })],
    ['no cohorts, no audit report', (i) => ({ ...i, cohorts: [], auditReportHref: undefined })],
  ]
  for (const version of DEFINE_XML_VERSIONS)
    it.each(cases)(`v${version}: %s`, async (_, edit) => {
      expect(checkDefineXml(buildDefineXml({ ...edit(await inputs()), version }))).toEqual([])
    })

  it('keeps the cohort logic when there is no cohort count table', async () => {
    const xml = buildDefineXml({ ...(await inputs()), resultTables: [] })
    expect(xml).toContain('def:DefineVersion="2.1.0" def:CommentOID="COM.COHORTS"')
    expect(xml).toContain('<def:CommentDef OID="COM.COHORTS">')
  })

  it('names datasets and variables for SAS and declares the precision of float variables', async () => {
    const xml = buildDefineXml(await inputs())
    expect(xml).toContain('KeySequence="1"')
    expect(xml).toMatch(/<ItemDef OID="IT.CM_RESULT.TARGET_OUTCOMES" Name="TARGET_OUTCOMES" SASFieldName="TARGOUTC"/)
    expect(xml).toMatch(/<ItemDef OID="IT.CM_RESULT.RR" Name="RR" SASFieldName="RR" DataType="float" Length="\d+" SignificantDigits="\d+"/)
  })
})

describe('the checks catch defects', () => {
  const rules = (xml: string) => [...new Set(checkDefineXml(xml).map((i) => i.rule))].sort()
  let xml = ''
  it('on a modified copy of a clean define.xml', async () => {
    xml = buildDefineXml(await inputs())
    expect(rules(xml)).toEqual([])
    const mutate = (from: RegExp | string, to: string | ((m: string) => string)) => {
      const out = xml.replace(from, to as string)
      expect(out).not.toBe(xml)
      return out
    }
    // A dangling reference and the now-unused method.
    expect(rules(mutate(/MethodOID="MT.CM_RESULT"/g, 'MethodOID="MT.NOPE"'))).toEqual(['SS-DEF-003', 'SS-DEF-005'])
    // A derived variable without its method.
    expect(rules(mutate(/(<ItemRef ItemOID="IT.CM_RESULT.RR"[^>]*?) MethodOID="[^"]+"/, '$1'))).toEqual(['SS-DEF-010'])
    // Duplicate OID.
    expect(rules(mutate('<MethodDef OID="MT.SCCS_RESULT"', '<MethodDef OID="MT.CM_RESULT"'))).toContain('SS-DEF-002')
    // Order numbers with a gap.
    expect(rules(mutate(/(<ItemRef ItemOID="IT.CM_RESULT.ANALYSIS_ID" )OrderNumber="\d+"/, '$1OrderNumber="99"'))).toEqual(['SS-DEF-013'])
    // A text variable without Length.
    expect(rules(mutate(/(<ItemDef OID="IT.CM_RESULT.DATABASE_ID"[^>]*? DataType="text") Length="\d+"/, '$1'))).toEqual(['SS-DEF-023'])
    // Missing or clashing SAS names, missing precision, an over-long value-level slice, no key, no standards.
    // (The file name no longer matches either.)
    expect(rules(mutate(/ SASDatasetName="CMRESULT"/, ''))).toEqual(['SS-DEF-031', 'SS-DEF-036'])
    expect(rules(mutate(/SASDatasetName="CMRESULT"/, 'SASDatasetName="SCCSRESU"'))).toEqual(['SS-DEF-031', 'SS-DEF-036'])
    expect(rules(mutate(/(<ItemDef OID="IT.CM_RESULT.TARGET_OUTCOMES"[^>]*) SASFieldName="[^"]+"/, '$1'))).toEqual(['SS-DEF-032'])
    expect(rules(mutate(/(<ItemDef OID="IT.CM_RESULT.RR"[^>]*) SignificantDigits="\d+"/, '$1'))).toEqual(['SS-DEF-033'])
    expect(rules(mutate(/(<ItemDef OID="IT.CG_COHORT_COUNT.COHORT_SUBJECTS.C\d+"[^>]*) Length="\d+"/, '$1 Length="99"'))).toEqual(['SS-DEF-034'])
    expect(rules(mutate(/(<ItemGroupDef OID="IG.CM_RESULT"[\s\S]*?<\/ItemGroupDef>)/, (m: string) => m.replace(/ KeySequence="\d+"/g, '')))).toEqual(['SS-DEF-035'])
    expect(rules(mutate(/<def:Standards>[\s\S]*?<\/def:Standards>\n/, ''))).toEqual(['SS-DEF-030'])
    expect(rules(mutate('xlink:href="datasets/cmresult.json"', 'xlink:href="datasets/cm_result.json"'))).toEqual(['SS-DEF-036'])
    expect(rules(mutate(/(<ItemGroupDef OID="IG.CM_RESULT"[\s\S]*?)<def:Class Name="ADAM OTHER"\/>\n/, '$1'))).toEqual(['SS-DEF-037'])
    expect(rules(mutate(/ *<def:Standard OID="STD.CT.ADAM"[^\n]*\n/, ''))).toEqual(['SS-DEF-030'])
    // The v2.1 spelling of a standard name in v2.0 (a PMDA reject).
    const v20 = buildDefineXml({ ...(await inputs()), version: '2.0' })
    expect(rules(v20)).toEqual([])
    expect(rules(v20.replace('def:StandardName="ADaM-IG"', 'def:StandardName="ADaMIG"'))).toEqual(['SS-DEF-038'])
    expect(rules(mutate('Name="ADaMIG" Type="IG"', 'Name="ADaM-IG" Type="IG"'))).toEqual(['SS-DEF-038'])
    // Neither standard nor flagged non-standard.
    expect(rules(mutate(/(OID="IG.CM_RESULT"[^>]*) def:IsNonStandard="Yes"/, '$1'))).toEqual(['SS-DEF-029'])
  })

  it('on datasets that drift from their metadata', async () => {
    const out = await networkExport('2.1')
    const cm = JSON.parse(out.datasets['datasets/cmresult.json'])
    const drift = (edit: (d: typeof cm) => void) => {
      const d = structuredClone(cm)
      edit(d)
      return [...new Set(checkDatasetsAgainstDefine(out.defineXml, { ...out.datasets, 'datasets/cmresult.json': JSON.stringify(d) }).map((i) => i.rule))].sort()
    }
    expect(drift((d) => (d.records += 1))).toEqual(['SS-DSJ-003'])
    expect(drift((d) => d.columns.reverse())).toContain('SS-DSJ-004')
    expect(drift((d) => (d.columns.find((c: { name: string }) => c.name === 'RR').dataType = 'string'))).toEqual(['SS-DSJ-006'])
    expect(drift((d) => (d.rows[0][0] = null))).toEqual(['SS-DSJ-009'])
    expect(checkDatasetsAgainstDefine(out.defineXml, { ...out.datasets, 'datasets/extra.json': '{}' }).map((i) => i.rule)).toEqual(['SS-DSJ-010'])
    // Dataset-JSON v1.0: same checks, ITEMGROUPDATASEQ ignored.
    const v10 = await networkExport('2.1', '1.0')
    expect(checkDatasetsAgainstDefine(v10.defineXml, v10.datasets)).toEqual([])
    const cm10 = JSON.parse(v10.datasets['datasets/cmresult.json'])
    cm10.clinicalData.itemGroupData['IG.CM_RESULT'].records += 1
    expect(checkDatasetsAgainstDefine(v10.defineXml, { ...v10.datasets, 'datasets/cmresult.json': JSON.stringify(cm10) }).map((i) => i.rule)).toEqual(['SS-DSJ-003'])
    const { ['datasets/cmresult.json']: _, ...missing } = out.datasets
    expect(checkDatasetsAgainstDefine(out.defineXml, missing).map((i) => i.rule)).toEqual(['SS-DSJ-001'])
  })
})
