import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { auditCsvText } from '@/lib/audit/cellAuditor'
import { createKeyFile, unlockKeyFile } from '@/lib/security/signer'
import type { StudyConfig } from '@/types/studypack'
import { buildStudyPack, SealRefused, sealRefusals, type BuildPackParams } from './builder'
import { evaluateEvidence } from './evidence'

const enc = new TextEncoder()
const samples = path.resolve(__dirname, '../../../samples')
const csv = (n: number) => `database_id,cohort_id,cohort_subjects\nX,1,${n}\n`
const file = (n: number) => ({
  path: 'results/CohortGeneratorModule/cg_cohort_count.csv',
  role: 'result' as const,
  originalName: 'cg_cohort_count.csv',
  bytes: enc.encode(csv(n)),
  audit: auditCsvText(csv(n), 'cg', { countColumns: ['cohort_subjects'] }),
})
const base: BuildPackParams = { studyId: 'S', siteId: 'Site_A', cdmVersion: '5.4', minCellCount: 5, files: [file(120)] }

describe('sealRefusals: the library refuses to seal what the UI would block', () => {
  it('refuses small cells left in an audited file, in any assurance level', async () => {
    expect(sealRefusals({ ...base, files: [file(3)] })).toEqual(['results/CohortGeneratorModule/cg_cohort_count.csv: 1 small cell(s) / 0 identifier column(s) remain'])
    await expect(buildStudyPack({ ...base, files: [file(3)] })).rejects.toBeInstanceOf(SealRefused)
    await expect(buildStudyPack(base)).resolves.toMatchObject({ zipName: 'Site_A_S.studypack.zip' })
  })

  it('in regulatory studies refuses a pack without signature, sealed protocol, coordinator signature or evidence', () => {
    expect(sealRefusals({ ...base, assurance: 'regulatory' })).toEqual([
      'regulatory studies must be signed',
      'regulatory studies must seal the protocol as received',
      'regulatory studies need the coordinator signature on the protocol',
      'regulatory studies must include the data-quality and provenance evidence',
    ])
  })

  it('in regulatory studies refuses evidence that blocks (e.g. a DQD structural failure on a study table)', async () => {
    const reg = path.join(samples, 'regulatory')
    const config = JSON.parse(readFileSync(path.join(reg, 'protocol/study_config.json'), 'utf8')) as StudyConfig
    const signer = await unlockKeyFile(await createKeyFile({ name: 'Op', organization: 'A', role: 'operator' }, 'long enough passphrase', { iterations: 1000 }), 'long enough passphrase')
    const evidence = evaluateEvidence({ config, files: { 'evidence/dqd_results.json': new Uint8Array(readFileSync(path.join(reg, 'site/dqd_results_structural_failure.json'))) } })
    const reasons = sealRefusals({
      ...base,
      assurance: 'regulatory',
      signers: [{ signer, meaning: 'sealed' }],
      protocolBytes: new Uint8Array(readFileSync(path.join(reg, 'protocol/study_config.json'))),
      protocolSignatureBytes: new Uint8Array(readFileSync(path.join(reg, 'protocol/study_config.jws.json'))),
      evidence,
    })
    expect(reasons).toContain('Data quality (structural-conformance): isRequired on DRUG_EXPOSURE.DRUG_EXPOSURE_START_DATE')
    // Standard studies are not held to the regulatory evidence rules.
    expect(sealRefusals({ ...base, evidence: evaluateEvidence({ config: { ...config, assurance: 'standard' }, files: {} }) })).toEqual([])
  })
})
