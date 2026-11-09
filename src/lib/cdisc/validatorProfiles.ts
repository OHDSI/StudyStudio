/**
 * How the issues found by Study Studio's own define.xml checks (defineRules.ts) would be rated by the
 * Pinnacle 21 validation profile of each agency, plus the findings a validator is expected to report
 * on this tool's output by design.
 *
 * The choice of agency does not change the export: the output is kept free of anything rated Reject
 * or Error by either profile. It only changes how the remaining issues are rated and explained.
 *
 * Severities were read from Pinnacle 21 Community 4.2.0 (engines FDA 2508.1 and PMDA 2411.1,
 * "Define.xml" and "ADaM-IG 1.3" configurations) on 2026-11-09. The FDA configurations rate few rules
 * (AD0001 Reject) and the engine reports the others as Warning; the PMDA configurations rate them
 * Reject / Error / Warning. Validator releases change these, so treat the table as a guide, not as the
 * validator.
 * Which standards and versions an agency accepts is set by its data standards catalog, not here.
 */
import type { DefineXmlVersion } from './defineXml'
import type { DefineIssue } from './defineRules'

export const AGENCIES = ['FDA', 'PMDA', 'OTHER'] as const
export type Agency = (typeof AGENCIES)[number]
export type Severity = 'Reject' | 'Error' | 'Warning'

export const AGENCY_LABELS: Record<Agency, string> = {
  FDA: 'FDA (US)',
  PMDA: 'PMDA (Japan)',
  OTHER: 'Other / not decided',
}

export const AGENCY_NOTES: Record<Agency, string> = {
  FDA: 'Ratings from the Pinnacle 21 FDA profile (engine 2508.1), which reports define.xml issues as warnings. Check the FDA Data Standards Catalog for the accepted Define-XML, Dataset-JSON and CT versions.',
  PMDA: 'Ratings from the Pinnacle 21 PMDA profile (engine 2411.1). PMDA does not accept a submission with Reject issues. Check the PMDA data standards catalog for the accepted Define-XML, Dataset-JSON and CT versions.',
  OTHER: 'No agency profile applied. Issues are listed with the ratings of both the FDA and PMDA profiles.',
}

/** Pinnacle 21 rules corresponding to each Study Studio rule that has a known counterpart. */
export const P21_EQUIVALENT: Record<string, string[]> = {
  'SS-DEF-029': ['DD0120'],
  'SS-DEF-030': ['DD0006', 'DD0150'],
  'SS-DEF-031': ['DD0047', 'DD0051'],
  'SS-DEF-032': ['DD0070'],
  'SS-DEF-033': ['OD0071'],
  'SS-DEF-034': ['DD0123'],
  'SS-DEF-035': ['DD0040'],
  'SS-DEF-036': ['DD0052'],
  'SS-DEF-037': ['DD0054'],
  'SS-DEF-038': ['DD0021'],
  'SS-DSJ-001': ['DD0084'],
}

const P21_SEVERITY: Record<Exclude<Agency, 'OTHER'>, Record<string, Severity>> = {
  FDA: {
    AD0001: 'Reject',
  },
  PMDA: {
    AD0001: 'Reject',
    AD1024: 'Error',
    AD1026: 'Error',
    SD0061: 'Error',
    AD9999: 'Warning',
    DD0006: 'Reject',
    DD0150: 'Reject',
    DD0021: 'Reject',
    DD0047: 'Error',
    DD0051: 'Error',
    DD0070: 'Error',
    DD0123: 'Error',
    DD0040: 'Error',
    DD0052: 'Error',
    DD0054: 'Error',
    DD0120: 'Error',
    DD0084: 'Error',
    OD0071: 'Warning',
    DD0139: 'Warning',
  },
}

const RANK: Record<Severity, number> = { Reject: 3, Error: 2, Warning: 1 }

/** Rating of a Pinnacle 21 rule in an agency profile. */
export function p21Severity(rule: string, agency: Exclude<Agency, 'OTHER'>): Severity {
  return P21_SEVERITY[agency][rule] ?? 'Warning'
}

export interface RatedIssue extends DefineIssue {
  p21: string[]
  /** Highest rating among the corresponding Pinnacle 21 rules; undefined when there is no known counterpart. */
  severity: Partial<Record<Exclude<Agency, 'OTHER'>, Severity>>
}

export function rateIssues(issues: DefineIssue[]): RatedIssue[] {
  return issues.map((i) => {
    const p21 = P21_EQUIVALENT[i.rule] ?? []
    const severity: RatedIssue['severity'] = {}
    if (p21.length)
      for (const agency of ['FDA', 'PMDA'] as const)
        severity[agency] = p21.map((r) => p21Severity(r, agency)).sort((a, b) => RANK[b] - RANK[a])[0]
    return { ...i, p21, severity }
  })
}

export interface ExpectedFinding {
  p21: string
  /** What the validator checks when it reports this: define.xml alone, or the datasets with define.xml. */
  scope: 'define' | 'data'
  message: string
  severity: Record<Exclude<Agency, 'OTHER'>, Severity>
  /** Suggested explanation for the reviewer's guide. */
  explanation: string
}

const finding = (p21: string, scope: ExpectedFinding['scope'], message: string, explanation: string): ExpectedFinding => ({
  p21,
  scope,
  message,
  severity: { FDA: p21Severity(p21, 'FDA'), PMDA: p21Severity(p21, 'PMDA') },
  explanation,
})

/**
 * Findings a validator reports on this tool's output by design. Define-XML findings depend on the
 * version; dataset findings come from validating the Dataset-JSON files as ADaM data (observed with the
 * FDA engine; the PMDA engine 2411.1 did not process Dataset-JSON input, its ratings come from its
 * configuration).
 */
export function expectedFindings(version: DefineXmlVersion): ExpectedFinding[] {
  const define =
    version === '2.0'
      ? []
      : [
          finding(
            'DD0139',
            'define',
            "Standards 'ADaMIG' and 'ADaM' (CT) are not referenced",
            'The datasets are aggregated results of an OMOP CDM network study and follow no CDISC data structure; they are declared as non-standard (def:IsNonStandard="Yes") datasets of an ADaM submission. No dataset or code list can therefore reference the declared implementation guide and controlled terminology, which are declared because def:Standards is required.',
          ),
        ]
  return [
    ...define,
    finding(
      'AD0001',
      'data',
      'Missing ADSL dataset',
      'By design the study collects no subject-level data: each site returns aggregated results only, so there is no subject-level analysis dataset (ADSL). The submitted datasets are aggregated analysis results. This submission format should be agreed with the agency before submission.',
    ),
    finding(
      'AD1024',
      'data',
      'Traceability rules not executed due to missing DM dataset',
      'No SDTM datasets exist because no subject-level data are collected. Traceability is provided instead by the pinned analysis specification, programs and package versions (section 7) and by the sealed, hash-verified site results.',
    ),
    finding(
      'AD1026',
      'data',
      'Traceability rules not executed due to missing EX dataset',
      'As for AD1024: there is no SDTM EX dataset; exposures are defined as cohorts in the analysis specification (section 2.2).',
    ),
    finding(
      'SD0061',
      'data',
      'Domain referenced in define.xml, but dataset is missing',
      'Every dataset described in define.xml is present and referenced by its def:leaf. The validator reports this for Dataset-JSON input; naming the datasets by their SAS names instead would make the PMDA profile report them as split datasets (DD0050, Error).',
    ),
    finding(
      'AD9999',
      'data',
      'Dataset not validated',
      'Validator rules cover only the ADSL, BDS and OCCDS structures; these "ADAM OTHER" datasets are not checked by them. OHDSI Study Studio checks each dataset against define.xml instead (names, types, keys, lengths, mandatory values, record counts).',
    ),
  ]
}
