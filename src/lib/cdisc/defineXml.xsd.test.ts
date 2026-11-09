import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { crossCheckSites, loadStudyPack, siteVerdict } from '@/lib/network/aggregator'
import { buildRegulatoryExport } from '@/lib/export/regulatory'
import { DEFINE_XML_VERSIONS } from './defineXml'
import type { StudyConfig } from '@/types/studypack'

/**
 * Validates the define.xml produced from the network demo against the CDISC Define-XML schemas with
 * xmllint. Skipped unless STUDYSTUDIO_DEFINE_XSD points to a `schemas` folder laid out as in
 * cdisc-org/data-definition-engine (define/2.1, define/2.0, odm/1.3.2); CI fetches it at a pinned commit.
 */
const schemas = process.env.STUDYSTUDIO_DEFINE_XSD
const samples = path.resolve(__dirname, '../../../samples')
const xsd = { '2.1': 'define/2.1/define2-1-0.xsd', '2.0': 'define/2.0/define2-0-0.xsd' } as const

describe.skipIf(!schemas)('define.xml against the CDISC schemas', () => {
  it.each(DEFINE_XML_VERSIONS)('Define-XML %s is schema-valid', async (version) => {
    const config = JSON.parse(readFileSync(path.join(samples, 'protocol/study_config.json'), 'utf8')) as StudyConfig
    const dir = path.join(samples, 'network')
    const sites = await Promise.all(readdirSync(dir).map((f) => loadStudyPack(f, readFileSync(path.join(dir, f)))))
    const cross = crossCheckSites(sites, config.expectedHashes, config.protectedSections, [...Object.keys(config.expectedHashes), ...Object.keys(config.protectedSections)])
    const rows = sites.map((s) => {
      const verdict = siteVerdict(s, cross, config.studyId, sites)
      return { site: s, verdict, adopted: verdict.recommended === 'adopt' }
    })
    const out = await buildRegulatoryExport({
      studyId: config.studyId,
      studyTitle: config.studyTitle,
      config,
      cross,
      rows,
      defineXmlVersion: version,
      // Exercise the xml-stylesheet instruction too.
      stylesheet: { name: `define${version.replace('.', '-')}-0.xsl`, text: '' },
    })
    // The demo must cover every kind of dataset the builder emits.
    for (const g of ['IG.CM_RESULT', 'IG.CG_COHORT_COUNT', 'IG.SRC_PATIENTS', 'IG.CDM_PERSON']) expect(out.defineXml).toContain(`<ItemGroupDef OID="${g}"`)
    expect(out.defineXml).toContain('<def:WhereClauseDef ')
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'define-xsd-')), `define-${version}.xml`)
    writeFileSync(file, out.defineXml)
    let output = ''
    try {
      output = execFileSync('xmllint', ['--noout', '--schema', path.join(schemas!, xsd[version]), file], { encoding: 'utf8', stdio: 'pipe' })
    } catch (e) {
      const err = e as { stderr?: string; message: string }
      throw new Error(`define.xml (v${version}) is not schema-valid:\n${err.stderr || err.message}`)
    }
    expect(output).toBe('')
  })
})
