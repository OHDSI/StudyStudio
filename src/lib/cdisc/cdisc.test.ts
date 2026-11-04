import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { buildDefineXml } from './defineXml'
import { buildDatasetJson, buildDatasetJson10, combineSiteCsvs } from './datasetJson'
import { parseMappingSpec, parseScanReport } from './sources'
import { parseAnalysisSpecification } from '@/lib/strategus/spec'
import { auditResultFiles, collectRdms, readResultsZip } from '@/lib/strategus/results'

const samples = path.resolve(__dirname, '../../../samples')

describe('sources', () => {
  it('parses Rabbit-In-A-Hat style mappings', () => {
    const m = parseMappingSpec(JSON.parse(readFileSync(path.join(samples, 'site/mapping_specification.json'), 'utf8')))
    expect(m.fieldMaps).toHaveLength(5)
    expect(m.tableMaps.map((t) => t.targetTable)).toEqual(['person', 'condition_occurrence'])
  })
  it('parses ScanReport Field Overview', () => {
    const t = parseScanReport(readFileSync(path.join(samples, 'site/ScanReport_sanitized.xlsx')))
    expect(t.map((x) => x.name)).toEqual(['patients', 'diagnoses'])
    expect(t[0].fields[2]).toMatchObject({ name: 'birth_year', type: 'int' })
  })
})

const spec = () => parseAnalysisSpecification(readFileSync(path.join(samples, 'study-repo/inst/analysisSpecifications.json'), 'utf8'))

async function resultTables() {
  const files = await readResultsZip(readFileSync(path.join(samples, 'site/strategus_results_Site_A.zip')))
  const rdms = collectRdms(files)
  const dec = new TextDecoder()
  return files
    .filter((f) => !f.path.endsWith('resultsDataModelSpecification.csv'))
    .map((f) => {
      const [module, file] = f.path.split('/')
      const table = file.replace(/\.csv$/, '')
      return combineSiteCsvs([{ siteId: 'Site_A', csv: dec.decode(f.bytes) }], { sourceTable: table, module, rdms: rdms.get(module)?.get(table) })
    })
}

describe('Dataset-JSON', () => {
  it('combines sites with SITE_ID and types columns from the results data model', () => {
    const t = combineSiteCsvs(
      [
        { siteId: 'A', csv: 'database_id,cohort_id,cohort_subjects,rr\nA_DB,1,120,1.5\n' },
        { siteId: 'B', csv: 'database_id,cohort_id,cohort_subjects\nB_DB,1,-5\n' },
      ],
      {
        sourceTable: 'cg_cohort_count',
        module: 'CohortGeneratorModule',
        rdms: [
          { name: 'database_id', dataType: 'varchar', required: true, primaryKey: true, minCellCount: false },
          { name: 'cohort_id', dataType: 'bigint', required: true, primaryKey: true, minCellCount: false },
          { name: 'cohort_subjects', dataType: 'bigint', required: true, primaryKey: false, minCellCount: true, description: 'Unique subjects' },
          { name: 'rr', dataType: 'float', required: false, primaryKey: false, minCellCount: false },
        ],
      },
    )
    expect(t.name).toBe('CG_COHORT_COUNT')
    expect(t.columns.map((c) => [c.name, c.dataType, !!c.primaryKey])).toEqual([
      ['SITE_ID', 'string', true],
      ['DATABASE_ID', 'string', true],
      ['COHORT_ID', 'integer', true],
      ['COHORT_SUBJECTS', 'integer', false],
      ['RR', 'double', false],
    ])
    expect(t.rows).toEqual([
      ['A', 'A_DB', 1, 120, 1.5],
      ['B', 'B_DB', 1, -5, null],
    ])
    const ds = buildDatasetJson(t, { studyOID: 'S', metaDataVersionOID: 'M', originator: 'o', sourceVersion: '1' })
    expect(ds).toMatchObject({ datasetJSONVersion: '1.1.0', itemGroupOID: 'IG.CG_COHORT_COUNT', records: 2 })
    expect(ds.columns.filter((c) => c.keySequence).map((c) => c.name)).toEqual(['SITE_ID', 'DATABASE_ID', 'COHORT_ID'])
  })
  it('downgrades a declared integer column to string when a site used "<5"', () => {
    const t = combineSiteCsvs([{ siteId: 'A', csv: 'n\n<5\n' }], { rdms: [{ name: 'n', dataType: 'int', required: true, primaryKey: false, minCellCount: true }] })
    expect(t.columns[1].dataType).toBe('string')
  })
})

describe('Dataset-JSON v1.0', () => {
  it('nests data under clinicalData.itemGroupData with ITEMGROUPDATASEQ', () => {
    const t = combineSiteCsvs([{ siteId: 'A', csv: 'cohort_id,cohort_subjects\n1,120\n2,-5\n' }], { sourceTable: 'cg_cohort_count' })
    const ds = buildDatasetJson10(t, { studyOID: 'S', metaDataVersionOID: 'M', originator: 'o', sourceVersion: '1' })
    expect(ds.datasetJSONVersion).toBe('1.0.0')
    const ig = ds.clinicalData.itemGroupData['IG.CG_COHORT_COUNT']
    expect(ig.items.map((i) => i.name)).toEqual(['ITEMGROUPDATASEQ', 'SITE_ID', 'COHORT_ID', 'COHORT_SUBJECTS'])
    expect(ig.itemData).toEqual([
      [1, 'A', 1, 120],
      [2, 'A', 2, -5],
    ])
  })
})

const definedAndReferenced = (xml: string) => {
  const defined = new Set([...xml.matchAll(/ (?:OID|ID)="([^"]+)"/g)].map((m) => m[1]))
  const refs = [...xml.matchAll(/(?:ItemOID|MethodOID|WhereClauseOID|ValueListOID|def:CommentOID|leafID|def:ArchiveLocationID)="([^"]+)"/g)].map((m) => m[1])
  return refs.filter((r) => !defined.has(r))
}

describe('Define-XML v2.1', () => {
  it('describes every Strategus result table, cohort and ETL mapping', async () => {
    const xml = buildDefineXml({
      studyId: 'S1',
      studyTitle: 'Study <1> & "co"',
      sourceSystemVersion: '0.1.0',
      cohorts: spec().cohorts,
      resultTables: await resultTables(),
      scanTables: parseScanReport(readFileSync(path.join(samples, 'site/ScanReport_sanitized.xlsx'))),
      mapping: parseMappingSpec(JSON.parse(readFileSync(path.join(samples, 'site/mapping_specification.json'), 'utf8'))),
      auditReportHref: 'audit_report.html',
    })
    expect(XMLValidator.validate(xml)).toBe(true)
    const doc = new XMLParser({ ignoreAttributes: false }).parse(xml)
    expect(doc.ODM.Study.MetaDataVersion['@_def:DefineVersion']).toBe('2.1.0')
    expect(xml).toContain('xmlns:def="http://www.cdisc.org/ns/def/v2.1"')
    for (const t of ['CG_COHORT_COUNT', 'CM_RESULT', 'CM_DIAGNOSTICS_SUMMARY', 'SCCS_RESULT', 'DATABASE_META_DATA', 'CDM_CONDITION_OCCURRENCE', 'SRC_PATIENTS'])
      expect(xml).toContain(`<ItemGroupDef OID="IG.${t}"`)
    expect(xml).toContain('<def:WhereClauseDef OID="WC.CG_COHORT_COUNT.COHORT_ID.1781"')
    expect(xml).toContain('<def:ValueListDef OID="VL.CG_COHORT_COUNT.COHORT_SUBJECTS">')
    expect(xml).toContain('xlink:href="datasets/cm_result.json"')
    expect(xml).toContain('The number of subject in the target cohort.') // description from the results data model
    expect(xml).toContain('censored values are reported as -minCellCount')
    expect(definedAndReferenced(xml)).toEqual([])
  })
})

describe('Define-XML v2.0', () => {
  it('uses the v2.0 namespace and omits v2.1-only constructs', async () => {
    const xml = buildDefineXml({
      version: '2.0',
      studyId: 'S1',
      studyTitle: 'S',
      sourceSystemVersion: '0.1.0',
      cohorts: spec().cohorts,
      resultTables: await resultTables(),
      scanTables: parseScanReport(readFileSync(path.join(samples, 'site/ScanReport_sanitized.xlsx'))),
    })
    expect(XMLValidator.validate(xml)).toBe(true)
    expect(xml).toContain('xmlns:def="http://www.cdisc.org/ns/def/v2.0"')
    expect(xml).toContain('def:DefineVersion="2.0.0" def:StandardName="ADaMIG" def:StandardVersion="1.3"')
    for (const v21 of ['def:Standards', 'def:IsNonStandard', 'def:Context', 'Type="Collected"', 'ns/def/v2.1']) expect(xml).not.toContain(v21)
    expect(xml).toContain('<def:Origin Type="eDT">')
    expect(definedAndReferenced(xml)).toEqual([])
  })
})

describe('results re-audit used by the export', () => {
  it('passes the clean sample', async () => {
    const audits = auditResultFiles(await readResultsZip(readFileSync(path.join(samples, 'site/strategus_results_Site_A.zip'))), { minCellCount: 5 })
    expect([...audits.values()].every((a) => a.passed)).toBe(true)
  })
})
