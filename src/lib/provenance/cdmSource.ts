/**
 * CDM, vocabulary and software provenance (requirements R3).
 *
 * Everything is read from files Strategus, DQD and the ETL already produce — nothing new has to run in R:
 *   results/DatabaseMetaData/database_meta_data.csv   (a copy of cdm_source written by Strategus)
 *   evidence/dqd_results.json                          (DQD metadata)
 *   etl/vocabulary_version.json                        (Athena download record)
 *   code/renv.lock                                     (R and HADES package versions)
 */
import Papa from 'papaparse'
import type { DqdMetadata } from '@/lib/audit/dqdAuditor'
import type { StudyConfig } from '@/types/studypack'

export const DATABASE_META_DATA = 'DatabaseMetaData/database_meta_data.csv'

export interface CdmSourceFacts {
  databaseId?: string
  cdmSourceName?: string
  cdmSourceAbbreviation?: string
  cdmHolder?: string
  sourceReleaseDate?: string
  cdmReleaseDate?: string
  cdmVersion?: string
  vocabularyVersion?: string
  maxObservationPeriodEndDate?: string
}

export interface SoftwareVersions {
  r?: string
  /** HADES / OHDSI packages pinned in renv.lock. */
  packages: Record<string, string>
}

export interface ProvenanceIssue {
  severity: 'block' | 'warn'
  code: string
  message: string
}

export interface ProvenanceReport {
  cdmSource?: CdmSourceFacts
  dqd?: Pick<DqdMetadata, 'cdmSourceName' | 'cdmVersion' | 'vocabularyVersion' | 'dqdVersion'>
  etlVocabularyVersion?: string
  software: SoftwareVersions
  /** Strategus modules in the analysis specification vs. modules with results (R3.4). */
  modules: { expected: string[]; present: string[]; missing: string[] }
  issues: ProvenanceIssue[]
}

const dec = new TextDecoder()

export function parseDatabaseMetaData(text: string): CdmSourceFacts | undefined {
  const rows = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: 'greedy' }).data
  const r = rows[0]
  if (!r) return undefined
  const get = (k: string) => {
    const key = Object.keys(r).find((x) => x.toLowerCase() === k)
    const v = key ? r[key]?.trim() : undefined
    return v || undefined
  }
  return {
    databaseId: get('database_id'),
    cdmSourceName: get('cdm_source_name'),
    cdmSourceAbbreviation: get('cdm_source_abbreviation'),
    cdmHolder: get('cdm_holder'),
    sourceReleaseDate: get('source_release_date'),
    cdmReleaseDate: get('cdm_release_date'),
    cdmVersion: get('cdm_version'),
    vocabularyVersion: get('vocabulary_version'),
    maxObservationPeriodEndDate: get('max_obs_period_end_date'),
  }
}

const HADES = /^(Strategus|CohortGenerator|CohortMethod|SelfControlledCaseSeries|PatientLevelPrediction|Characterization|CohortIncidence|CohortDiagnostics|EvidenceSynthesis|FeatureExtraction|DatabaseConnector|SqlRender|Cyclops|ParallelLogger|ResultModelManager|DataQualityDashboard|Andromeda|EmpiricalCalibration)$/

export function softwareVersions(renvLockText?: string): SoftwareVersions {
  if (!renvLockText) return { packages: {} }
  try {
    const j = JSON.parse(renvLockText) as { R?: { Version?: string }; Packages?: Record<string, { Package?: string; Version?: string }> }
    const packages: Record<string, string> = {}
    for (const [name, p] of Object.entries(j.Packages ?? {})) if (HADES.test(name) && p.Version) packages[name] = p.Version
    return { r: j.R?.Version, packages }
  } catch {
    return { packages: {} }
  }
}

/** Version strings compared loosely: case, surrounding whitespace and a leading "v" are ignored. */
export const sameVersion = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase().replace(/^v/, '') === b.trim().toLowerCase().replace(/^v/, '')

export interface ProvenanceInput {
  config?: StudyConfig
  /** Files keyed by StudyPack path (results under "results/"). */
  files: Record<string, Uint8Array>
  dqd?: DqdMetadata
}

export function evaluateProvenance({ config, files, dqd }: ProvenanceInput): ProvenanceReport {
  const issues: ProvenanceIssue[] = []
  const regulatory = config?.assurance === 'regulatory'
  const severe = (cond: boolean): 'block' | 'warn' => (cond && regulatory ? 'block' : 'warn')

  const dbmText = files[`results/${DATABASE_META_DATA}`]
  const cdmSource = dbmText ? parseDatabaseMetaData(dec.decode(dbmText)) : undefined
  if (!cdmSource) issues.push({ severity: severe(true), code: 'cdm-source-missing', message: `results/${DATABASE_META_DATA} (cdm_source) is missing, so the CDM and vocabulary versions cannot be traced` })

  let etlVocabularyVersion: string | undefined
  const vv = files['etl/vocabulary_version.json']
  if (vv) {
    try {
      const j = JSON.parse(dec.decode(vv)) as Record<string, unknown>
      etlVocabularyVersion = String(j.vocabularyVersion ?? j.vocabulary_version ?? '') || undefined
    } catch {
      issues.push({ severity: 'warn', code: 'etl-vocabulary-invalid', message: 'etl/vocabulary_version.json is not valid JSON' })
    }
  }

  const vocab = cdmSource?.vocabularyVersion
  if (vocab && dqd?.vocabularyVersion && !sameVersion(vocab, dqd.vocabularyVersion))
    issues.push({ severity: severe(true), code: 'dqd-vocabulary-mismatch', message: `DQD ran on vocabulary ${dqd.vocabularyVersion}, but the results come from ${vocab} — DQD was run on a different CDM build` })
  if (vocab && etlVocabularyVersion && !sameVersion(vocab, etlVocabularyVersion))
    issues.push({ severity: 'warn', code: 'etl-vocabulary-mismatch', message: `etl/vocabulary_version.json says ${etlVocabularyVersion}, cdm_source says ${vocab}` })
  if (cdmSource?.cdmSourceName && dqd?.cdmSourceName && cdmSource.cdmSourceName !== dqd.cdmSourceName)
    issues.push({ severity: severe(true), code: 'dqd-source-mismatch', message: `DQD ran on "${dqd.cdmSourceName}", but the results come from "${cdmSource.cdmSourceName}"` })
  if (cdmSource?.cdmVersion && dqd?.cdmVersion && !sameVersion(cdmSource.cdmVersion, dqd.cdmVersion))
    issues.push({ severity: 'warn', code: 'dqd-cdm-version-mismatch', message: `DQD reports CDM ${dqd.cdmVersion}, cdm_source reports ${cdmSource.cdmVersion}` })

  const req = config?.cdmRequirements
  const cdmVersion = cdmSource?.cdmVersion
  if (req?.cdmVersion && cdmVersion && !sameVersion(req.cdmVersion, cdmVersion))
    issues.push({ severity: severe(true), code: 'cdm-version-requirement', message: `Protocol requires CDM ${req.cdmVersion}; this database is CDM ${cdmVersion}` })
  if (req?.vocabularyVersion && vocab && !sameVersion(req.vocabularyVersion, vocab))
    issues.push({ severity: severe(true), code: 'vocabulary-requirement', message: `Protocol requires vocabulary ${req.vocabularyVersion}; this database uses ${vocab}` })
  if (!req?.cdmVersion && config?.cdmVersion && cdmVersion && !sameVersion(config.cdmVersion, cdmVersion))
    issues.push({ severity: 'warn', code: 'cdm-version-differs', message: `Protocol CDM version is ${config.cdmVersion}; this database is CDM ${cdmVersion}` })

  const expected = (config?.framework?.modules ?? []).filter(Boolean)
  const present = [...new Set(Object.keys(files).filter((p) => p.startsWith('results/') && p.endsWith('.csv')).map((p) => p.split('/')[1]))].sort()
  const missing = expected.filter((m) => !present.includes(m))
  if (missing.length) issues.push({ severity: severe(true), code: 'modules-missing', message: `No results for module(s) in the analysis specification: ${missing.join(', ')}` })

  const renv = files['code/renv.lock']
  return {
    cdmSource,
    dqd: dqd && { cdmSourceName: dqd.cdmSourceName, cdmVersion: dqd.cdmVersion, vocabularyVersion: dqd.vocabularyVersion, dqdVersion: dqd.dqdVersion },
    etlVocabularyVersion,
    software: softwareVersions(renv ? dec.decode(renv) : undefined),
    modules: { expected, present, missing },
    issues,
  }
}
