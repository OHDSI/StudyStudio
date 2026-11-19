# Assessment: can Study Studio make an external-control-arm RWE analysis auditable?

*Assessment dated 2026-11-19. It covers `main` at `bf0b55e`. No code was changed for it.*

## Why this assessment

On 2026-11-19 Eisai and Biogen presented 3-year real-world data for lecanemab from the LEADER study at
CTAD 2026. The headline result compares 504 treated patients with 573 patients from the ADNI
natural-history cohort, adjusted for background characteristics, and reports a hazard ratio of 0.24 (95% CI
0.15–0.39) for progression to moderate or severe dementia, in a pre-specified analysis at 36 months. The
other figures (81.1% of 546 evaluable patients maintained or improved their stage; 87.5% of 560 still on
treatment; no ARIA in the n=64 subcutaneous subgroup) have no concurrent control.

This document uses that announcement only as a pattern: an external-control-arm (ECA) comparison
across sites. It makes no claim about how LEADER was actually run. Everything known about LEADER here comes
from the press release. The question is narrower: **if a team ran a study of this shape with OHDSI Strategus
and Study Studio, which of the five questions a reviewer would ask could they answer from Study Studio's
artefacts, and which could they not?**

Every statement about the implementation below cites the code. Where a document claims something the code
does not do, the assessment says so.

### A structural point first

Strategus runs the same analysis specification at each site, and each site returns aggregate results.
CohortMethod estimates a hazard ratio *inside one database*: the target and comparator cohorts must both
be in the CDM the analysis runs on. A LEADER-style comparison pools treated patients from 13 sites with
patients from a different source (ADNI), so the adjustment model is fitted on **pooled patient-level data**.
That can fit Study Studio in only two ways:

- **(A) Pooled CDM.** The treated-patient data and an OMOP conversion of ADNI are loaded into one CDM, and
  one Strategus run with CohortMethod (target = treated, comparator = ADNI cohort) is executed there. To
  Study Studio this is **one site**. The whole ECA happens inside one sealed StudyPack, and the 13 source
  sites appear only as whatever the pooled CDM's ETL documentation says about them.
- **(B) Federated.** Each of the 13 sites (and ADNI) runs Strategus separately. Study Studio fits this
  model naturally, but no site can compute the ECA hazard ratio: no single database holds both arms. Sites
  can contribute characterisation, cohort counts and descriptive outcomes. The comparison itself would be
  computed somewhere else, on data Study Studio never sees.

So for the headline number, Study Studio can at most make auditable the run that produced it (shape A),
or the inputs to it (shape B). It never sees the comparison itself in shape B. The assessment below has
this in mind throughout.

---

## 1. Comparator provenance

*How was the ADNI control cohort built (source data version, inclusion and exclusion criteria, matching or
adjustment variables and method, who ran it), and can an auditor reconstruct it?*

### (a) What Study Studio captures or enforces today

- **Inclusion and exclusion criteria, and the adjustment method, are pinned byte for byte.** This holds
  when they are expressed in the Strategus analysis specification. The specification holds the Circe
  cohort definitions (target, comparator, outcomes) and the CohortMethod settings: the covariate settings
  for the propensity model, and the matching, stratification or weighting and outcome-model arguments.
  `issueProtocol()` (`src/lib/strategus/protocol.ts:135`) records its SHA-256 in
  `study_config.expectedHashes`, and records the protected section of `ExecuteAnalyses.R` and `renv.lock`
  the same way. The Aggregator compares every pack against these hashes (`crossCheckSites()`,
  `src/lib/network/aggregator.ts:242`). A mismatch becomes a `PROTOCOL_DEVIATION`
  (`siteVerdict()`, `aggregator.ts:296`).
- **The run used those inputs.** In regulatory studies, `recordStrategusRun()` (`r/recordStrategusRun.R`)
  hashes the specification, the protected script section and `renv.lock` before `Strategus::execute()`.
  It also hashes every results file afterwards. `checkRunRecord()` (`src/lib/strategus/runRecord.ts:226`)
  blocks the seal if the inputs or outputs differ. A missing record also blocks
  (`judgeEvidence()`, `src/lib/studypack/evidence.ts:129`).
- **Which database.** Strategus writes `DatabaseMetaData/database_meta_data.csv` (a copy of `cdm_source`)
  during the run, and the run record hashes it, so the CDM identity is bound to the run.
  `evaluateProvenance()` (`src/lib/provenance/cdmSource.ts:98`) parses `cdm_source_name`, `cdm_holder`,
  `source_release_date`, `cdm_release_date`, the CDM and vocabulary versions and
  `max_obs_period_end_date`. It cross-checks them against the DQD metadata and
  `etl/vocabulary_version.json`.
- **Who ran it.** In regulatory studies the StudyPack must be signed (`sealRefusals()`,
  `src/lib/studypack/builder.ts:311`). The signer must be enrolled in a signer roster that the protocol
  issuer has signed. The roster records name, role, organisation, who verified the identity, how, and any
  revocation (`src/lib/security/signer.ts`, requirements R1.5).
- **ETL lineage.** This is optional. If a site supplies the WhiteRabbit ScanReport and the Rabbit-in-a-Hat
  mapping specification (`etl/` slots, `src/lib/studypack/slots.ts:31-32`), the audit report renders
  them per site (`etlSection()`, `src/lib/export/regulatory.ts:105`).

### (b) Verdict: **partially covered**

The *definitions* and the *method* are pinned, and so is the run that applied them, provided they live in
the Strategus specification. Four things are weak or missing:

1. **The version of the external source is free text.** For ADNI, the source data version (the data
   freeze or download date) would sit only in `cdm_source.source_release_date` or `cdm_source_name`. Both
   are optional. Neither can be pre-specified in the protocol. The only use of `source_release_date` is
   as a point on the timeline.
2. **An auditor cannot rebuild the comparator from the submission package.** `buildRegulatoryExport()`
   (`regulatory.ts:540`, contents assembled at lines 697–716) exports define.xml, the datasets, and each
   site's `manifest.json`, `manifest.jws.json` and `audit_report.json`, plus the disposition log. It does
   **not** export `study_config.json`, its coordinator signature, `analysisSpecifications.json`,
   `renv.lock`, the execution script, or the signer roster. The site manifests list the *hashes* of the
   protocol files but not the files. A reviewer gets the fingerprint of the cohort definitions, not the
   cohort definitions. (define.xml carries a summary of each cohort's logic, generated in
   `src/lib/codegen/circe.ts`, but not the full expression.)
3. **The protocol does not say which pack plays which role.** Nothing in `study_config` states that a
   given site is the external comparator source, or what source and release it must come from.
4. In shape B, the adjustment itself happens outside Study Studio (see the structural point above).

### (c) Smallest changes that would close the gap

- **C1. Export the protocol artefacts with the submission package.** In `buildRegulatoryExport()`, add
  these files to `content`:
  - `protocol/study_config.json` and `protocol/study_config.jws.json`: the coordinator's reference bytes,
    already held in the store as `configBytes` and `signatureBytes`;
  - `protocol/analysisSpecifications.json`, `protocol/renv.lock` and `protocol/ExecuteAnalyses.R`;
  - `roster/signer_roster.json` and `roster/signer_roster.jws.json`, when they are loaded.

  Before including each file, re-hash it against `config.expectedHashes` or `protectedSections`. If any
  file does not match, refuse the export in regulatory mode, the same way the lock is refused today. The
  files enter the package `manifest.json` through `manifestEntries()` as usual. With this change, every
  hash in a site manifest resolves to a file inside the package.
- **C2. Pre-specified data sources.** Add an optional field to `StudyConfig`
  (`src/types/studypack.ts`):

  ```
  sites?: { siteId: string; role?: string; cdmSourceName?: string; sourceReleaseDate?: string }[]
  ```

  `role` is free text, for example `"treated"` or `"external-comparator"`. The coordinator enters the
  field in the Protocol Issuer, so it is signed with the protocol. In `siteVerdict()`, compare each pack's
  `siteId` and parsed `cdm_source` with its entry. A mismatch becomes a `CDM_REQUIREMENT` exclusion in
  regulatory mode and a warning otherwise. The reviewer's guide site table (`reviewersGuide.ts:134`) gains
  a *Role* and a *Source release* column. The same list closes gap 4 below.

---

## 2. Endpoint ascertainment

*Was "disease stage" and its progression defined the same way, and applied the same way, at all 13 sites,
and can that be shown?*

### (a) What Study Studio captures or enforces today

- **The same definition, shown rather than asserted.** Outcome cohort definitions are part of the pinned
  specification, so every adopted site's definition is byte-identical to the protocol's (section 1).
  In regulatory mode, the run record shows that the run read that exact file.
- **The vocabulary the definition was resolved against.** Each site's vocabulary version is read from
  `cdm_source` and checked against the DQD metadata. A mismatch blocks in regulatory mode
  (`cdmSource.ts:119-120`). The protocol can require one exact vocabulary version
  (`cdmRequirements.vocabularyVersion`, `cdmSource.ts:132-133`), which then blocks in regulatory mode.
- **Data quality on the tables the cohorts use.** The DQD gate is scoped to the CDM tables that the cohort
  definitions reference (`studyTablesFor()` in `src/lib/audit/dqdAuditor.ts`). Its policy is pinned in
  `study_config.dataQuality`.
- **Per-site ETL mappings,** when supplied, are rendered in the audit report. They are not compared
  across sites.

### (b) Verdict: **partially covered**

"The same definition" is shown. "Applied the same way" is shown only as far as the same vocabulary version
and a passing DQD gate go. Three things are not shown:

1. **How concept sets resolved at each site.** A concept set with descendants resolves to different
   concept IDs under different vocabularies, and to different *source* codes at each site. If
   CohortDiagnostics is in the specification, its result tables (included source concepts, orphan
   concepts, index event breakdown) contain exactly this evidence. Study Studio seals and hashes them but
   never reads or compares them.
2. **How each site mapped its clinical records to the concepts the definition uses.** For an endpoint
   such as dementia stage, that means where a CDR or MMSE value or a clinician's staging lives in the
   source. This is site ETL. The mapping specification is optional (`slots.ts:32`) and is never compared.
3. **If the stage comes from chart abstraction or unstructured notes, no OMOP cohort definition captures
   it.** Neither does Study Studio. That belongs to the source-to-CDM reconciliation, which
   `docs/regulatory/requirements.md` limitation 4 already places outside the tool.

### (c) Smallest changes that would close the gap

- **E1. A resolved-concept fingerprint per site.** This is a report-only check. When a pack contains the
  CohortDiagnostics included-source-concept or resolved-concept tables (confirm the exact table and column
  names against the module's `resultsDataModelSpecification.csv` before implementing), compute for each
  site and each concept set the SHA-256 of the sorted distinct standard `concept_id`s. Show a matrix in
  the audit report: rows are concept sets, columns are sites, and cells differing from the majority are
  marked. Also count the source codes mapped per concept set and site. It never blocks, like
  `src/lib/network/plausibility.ts`. It adds no work for sites, because the data is already in the pack
  when the module ran.
- **E2. A cross-site mapping comparison for the study tables.** Where two or more adopted sites supply
  `mapping_specification.json`, list the target CDM fields among `dataQuality.studyTables` that different
  sites fill from different kinds of source field. This is descriptive and goes in the existing
  "Data lineage (site ETL)" section. It does not block.

Neither change makes the endpoint valid. They turn "same definition everywhere" from a claim about hashes
into a visible comparison of how the definition landed on each site's data.

---

## 3. Pre-specification

*Where is the pinned, timestamped record of the analysis plan, and the trail of any amendments?*

### (a) What Study Studio captures or enforces today

- **What is pinned.** The analysis specification, the protected script section and `renv.lock` are
  pinned by SHA-256 when the protocol is issued (`protocol.ts:135`). In regulatory mode,
  `study_config.json` also pre-specifies the DQD gate policy, the required CDM and vocabulary versions,
  and the reason codes for excluding a site (`protocol.ts:171-178`).
- **Who issued it, and when.** In regulatory mode `study_config.json` must carry the coordinator's ES256
  detached JWS, with `sp:signer`, `sp:signedAt` and `sp:meaning = protocol-issued`. Sites verify it when
  they import the protocol (`readProtocolFile()`, `protocol.ts:282`). Each site seals the protocol exactly
  as received (`protocol/study_config.json`), and a pack without it is refused (`builder.ts:317-318`).
- **Order in time.** `src/lib/provenance/timeline.ts:48-55` requires protocol issue ≤ Strategus log start,
  ≤ recorded run start, and ≤ seal. A seal before issue is a hard failure.
- **Different issues are caught.** A pack sealed under a different `issuedAt` than the coordinator's
  reference is flagged `PROTOCOL_DEVIATION` (`aggregator.ts:308-309`).

### (b) Verdict: **partially covered**

The *machine-readable* plan is pinned and attributable. Four gaps remain:

1. **There is no amendment trail.** `configVersion` is fixed at `'1.0.0'` (`src/types/studypack.ts:68`).
   No field links a re-issued protocol to the one it replaces. A pack sealed under the earlier issue gets
   the same `PROTOCOL_DEVIATION` as a pack from a tampered protocol. The reviewer's guide leaves
   **"Protocol versions: TO BE COMPLETED"** (`src/lib/export/reviewersGuide.ts:159`).
2. **The written protocol and analysis plan are not pinned.** The document that says "the primary
   analysis is at 36 months, these are the adjustment variables, this is the estimand" is not part of the
   protocol ZIP. Only the Strategus JSON is.
3. **The time is the coordinator's own clock.** `issuedAt` and `sp:signedAt` come from the coordinator's
   device clock. RFC 3161 time-stamps were removed (`0f1d838`), deliberately, to keep the tool offline.
   The order relative to *site runs* is checked. The order relative to *access to the comparator data*
   cannot be checked by any tool. That matters here because ADNI is open to approved researchers: an
   analysis team could have explored it before writing the plan. The usual answer is registration in a
   public registry (EU PAS Register, ClinicalTrials.gov, OSF) before analysis, and Study Studio records
   no link to one.
4. **The submission package does not contain the protocol** (see C1).

### (c) Smallest changes that would close the gap

- **P1. An amendment chain.** Add an optional field to `StudyConfig`:

  ```
  amends?: { previousSha256: string; previousIssuedAt: string; summary: string }
  ```

  `previousSha256` is the SHA-256 of the previous `study_config.json` bytes. The Protocol Issuer fills the
  field when the coordinator drops the previous `study_config.json`, so the coordinator's signature covers
  it. The Aggregator accepts several reference configs. When a pack's sealed protocol hash is reachable
  through the `amends` chain from the current config, the finding becomes "sealed under an earlier issue
  (amendment N−1)". That is a warning, still decided and recorded in the disposition log, instead of an
  unexplained deviation. The reviewer's guide §2.1 lists the chain (issue time, hash, summary) in place of
  the TO-BE-COMPLETED line.
- **P2. Pinned plan documents.** Add an optional field to `StudyConfig`:

  ```
  documents?: { path: string; sha256: string; title: string }[]
  ```

  Each entry is, for example, `docs/protocol_v2.pdf` or `docs/sap_v1.pdf`. The files ship in the protocol
  ZIP under `docs/`. Sites seal them like other protocol files, with the same hash comparison in
  `crossCheckSites()`, and C1 exports them. The format stays opaque: the tool hashes the documents and
  never parses them.
- **P3. A declared registration.** Add an optional field to `StudyConfig`:

  ```
  registration?: { registry: string; id: string; registeredAt?: string }
  ```

  It is entered at issue, signed with the protocol, and shown in the audit report and reviewer's guide
  labelled *as declared by the coordinator; not verified by the tool*. The tool stays offline. The
  registry supplies the independent time anchor, so no time-stamp service has to come back.

---

## 4. Attrition transparency

*Who left, when and why? Are site-level dispositions and patient dropouts part of the evidence?*

There are two levels. Study Studio handles the first and not the second.

### (a) What Study Studio captures or enforces today

- **Site-level dispositions of the packs that arrive.** `DispositionLog` (`src/lib/network/dispositionLog.ts`)
  is an append-only JSONL file with a hash chain. It records every `received`, `adopt`, `exclude`, `lock`
  and `export` with actor, time, old → new decision and reason. An exclusion, or a decision against the
  automatic recommendation, needs a reason code that the protocol pre-specified, and `OTHER` also needs a
  written justification (`append()`, line 120). The codes include `WITHDRAWN`. In regulatory mode the
  dispositions must be locked, with an attestation, before export (`regulatory.ts:571-576`). The log and
  its head (signed, if a key is unlocked) go into the submission package (`regulatory.ts:711-715`).
- **Patient-level results pass through unread.** Any Strategus result CSV, including CohortMethod's
  attrition table and CohortGenerator's inclusion statistics when those modules write them, is sealed,
  hashed, audited for small cells and exportable as a dataset. Study Studio itself never reads, summarises
  or compares them. A search of `src/` for `attrition` finds nothing.
- **The data cut-off is parsed and then dropped.** `max_obs_period_end_date` is parsed
  (`cdmSource.ts:70`) but never displayed or exported. `source_release_date` appears only in the site UI
  (`src/features/common/EvidenceView.tsx:100`), not in any exported report.

### (b) Verdict: **site level partially covered; patient level not covered**

1. **A site that never sends a pack leaves no trace.** The Aggregator knows only the packs dropped on it,
   so a 14th site that dropped out is invisible to the log, the audit report and the reviewer's guide.
   For selection bias this is the most important site-level gap.
2. **Patient attrition is evidence in the package, but no reader would find it.** The 560 → 546
   evaluable → 504 analysed steps, and on-treatment status at extraction, would exist only as rows in
   exported datasets. Nothing presents them per site, and nothing flags a module whose attrition table is
   missing. Small-cell masking (`-minCellCount`) can also hide small attrition steps, and that is correct
   behaviour, but the report does not point it out.
3. **Reasons for discontinuation are not in scope.** "Why did they leave" is clinical source data (an
   adverse event, patient choice, death). OMOP records it only if the ETL captured it as an observation,
   and no Strategus module reports it as standard. Study Studio should not try to infer it.

### (c) Smallest changes that would close the gap

- **A1. Expected sites and a not-received disposition.** Use the `sites` list from C2. A plain
  `expectedSites?: string[]` would do if C2 is not adopted. Add a disposition action `not-received` that
  carries a `siteId`, a pre-specified `reasonCode` (for example `WITHDRAWN`, or a new `NOT_RECEIVED`) and
  text, and no `packSha256`. In regulatory mode, `LockCard` and the `buildRegulatoryExport()` lock check
  then require every expected site to have either a pack decision or a `not-received` entry. The audit
  report and the reviewer's guide site table list these sites. The change is in `dispositionLog.ts`
  (`ACTIONS`, `entryProblem`, `append`) and in `regulatory.ts`.
- **A2. An attrition section in the audit report.** This is report-only. For each adopted site, render
  the CohortMethod attrition table when it is present: the sequence of steps with description and subject
  counts per target-comparator-analysis, with censored values shown as `<k`, not `-k`. Also render the
  CohortGenerator inclusion-rule counts if present. Confirm the table names against the module RDMS files
  before implementing. When `CohortMethodModule` is in the specification and a site has no attrition
  table, add a review finding to the existing plausibility list.
- **A3. Show the data cut-off.** Add `source_release_date` and `max_obs_period_end_date` as columns in the
  audit report's §5 table (`regulatory.ts:352`) and in the reviewer's guide site table. They are already
  parsed, so no new input is needed.

---

## 5. Cross-site consistency

*Are vocabulary versions, data quality and local conventions captured with the results?*

### (a) What Study Studio captures or enforces today

- **Versions per site.** The audit report §5 shows CDM source name, CDM version and vocabulary version
  per site (`regulatory.ts:352-358`). The reviewer's guide lists the distinct vocabulary versions and a
  per-site table (`reviewersGuide.ts:94, 126, 134-138`). Mismatches inside a site (DQD against results)
  block in regulatory mode. A protocol-required version blocks a site that differs from it.
- **Data quality per site** against one pinned policy. Findings, policy version and policy hash are
  sealed in each `audit_report.json` (`builder.ts:219-230`).
- **Software.** HADES versions loaded in the run must match the pinned `renv.lock`. Other packages and
  the R version produce warnings (run record).
- **Code.** The protected section is identical across sites. The INPUTS block above the marker is
  allowed to differ, for example schema names or the SQL dialect.
- **Signs of copying or editing** across sites (`plausibility.ts`), for review only.

### (b) Verdict: **largely covered for versions and data quality; partially covered for local conventions**

1. If the coordinator did not require a vocabulary version, sites on *different* vocabularies raise no
   finding at all. The difference is visible in the table only to a reader who compares the rows.
2. The DQD results are judged per site against one gate, but nobody compares them across sites. For
   example, a plausibility check might fail on `MEASUREMENT` at three of thirteen sites without anyone
   noticing.
3. The database platform is not recorded. The run record keeps the R `platform` string but not
   `connectionDetails$dbms`, and SQL translation differences between platforms are a known source of
   site-to-site variation.
4. Local conventions in the ETL are rendered per site but never compared (see E2).

### (c) Smallest changes that would close the gap

- **X1. A heterogeneity table and review findings.** Add one table to the audit report: a row per adopted
  site, with columns for CDM version, vocabulary version, DQD version, DQD failures on study tables,
  source release, cut-off (A3), Strategus version loaded, R version and DBMS (X2). Mark every cell that
  differs from the majority. If no `cdmRequirements.vocabularyVersion` is set and the vocabulary versions
  differ, add a non-blocking review finding next to the plausibility findings. Also list each DQD check
  that fails at some adopted sites but not others, by check name and table.
- **X2. Record the DBMS in the run record.** In `r/recordStrategusRun.R`, record
  `connectionDetails$dbms` and nothing else from the connection: host, user and password are already kept
  out on purpose. Add `dbms?: string` to `RunRecordRun` (`runRecord.ts`). Extend `r/tests/cross-check.R`
  and `runRecord.r.test.ts` so the R and TypeScript sides stay in agreement. This is the only proposal
  that touches R.

---

## What Study Studio should not try to do

Study Studio is a packaging and provenance layer around a Strategus run. It should keep out of these
areas, and none of the proposals above enters them:

- **Building external cohorts.** Converting ADNI (or any registry) to OMOP, harmonising its assessments
  with clinical-practice records, or deciding which ADNI participants are eligible.
- **Matching, weighting or causal inference.** Propensity models, matching, IPTW, outcome models,
  estimands, sensitivity analyses (E-values, quantitative bias analysis), meta-analysis. Strategus and the
  HADES packages do this, or the sponsor's own statistics outside OHDSI. Study Studio carries their
  pinned settings and their outputs.
- **Judging whether an ECA is valid.** Whether ADNI participants (research volunteers with protocolised
  assessments) are exchangeable with treated patients in clinical practice is a scientific judgement. No
  hash, signature or gate addresses it. At most Study Studio can make the ECA's **inputs, definitions and
  decisions auditable**.
- **Verifying what it cannot see.** Blinding to comparative results, the correctness of site clocks, the
  identities behind keys, chart-abstraction quality, and source-to-CDM fidelity rest on SOPs.
  `docs/regulatory/requirements.md` already says so for each of them.
- **Becoming a time-stamp or registration service.** Removing RFC 3161 kept the tool offline. P3 records
  a registration; it does not reach out to one.

### Places where the UI or the documentation claims more than the code does

The README and `requirements.md` are careful. They say no regulator has reviewed the controls and that
the controls are this tool's design for meeting guidance principles. A few places still overreach or are
inaccurate:

1. **`requirements.md` R3.3 promises a field the code never writes.** It says "tool version + build id in
   `manifest.json`". `StudyPackManifest.tool.buildId` is declared (`src/types/studypack.ts:40`) but never
   set: `buildStudyPack()` writes only `{ name, version }` (`builder.ts:402`). Either set it at build time
   (for example a Vite `define` holding the git commit) or remove "build id" from R3.3.
2. **The reviewer's guide §4.2 states a fact the code does not guarantee.** It says "All datasets were
   produced by the same Strategus execution at each site" (`reviewersGuide.ts:209`). That is not
   guaranteed. The run record deliberately accepts files written by an *earlier* run with the same inputs
   (`skipCompletedTasks`, `runRecord.ts:289-291`), and in standard studies there is no run record at all.
   Suggested wording: "…by Strategus runs of the pinned specification at each site (see each site's run
   record, where present)".
3. **Two UI labels imply fitness for submission.** The assurance option reads "Regulatory (stricter
   controls, for submission use)" (`src/features/admin/ProtocolIssuer.tsx:219`), and the export is named
   `<studyId>_regulatory_submission.zip` (`regulatory.ts:763`). Either can be read as saying the output
   is fit to submit. "Regulatory (pre-specified gates, signatures, run record)" and
   `<studyId>_submission_package.zip` say what the tool actually does.
4. **The lock attestation is recorded but cannot be checked.** It reads "Comparative results between
   exposure groups were not viewed" (`DispositionPanel.tsx:233`). The README and R6.3 say the tool cannot
   verify this, but the card in the UI does not. In an ECA this matters more than usual, because the
   comparator data may have been open to the analysts long before any lock. A short line under the
   checkbox ("Recorded, not verified by the tool") would match the documentation.
5. **A "Clean" DQD badge is not fitness for use.** The site UI shows "Clean" for a passing data-quality
   and provenance section. DQD checks the CDM's internal conformance, completeness and plausibility. It
   does not show that the data are fit for a particular endpoint, as limitation 4 in `requirements.md`
   says. Wording such as "DQD gate passed" would avoid the reading that the data were judged fit for
   purpose.
6. **The README undersells schema validation.** Its *Limitations* section says the repository does not
   validate define.xml against the CDISC schemas. `src/lib/cdisc/defineXml.xsd.test.ts` and
   `.github/workflows/define-xsd.yml` do that, against a pinned schema commit. This is the opposite
   problem, but the README should still be corrected.

Nowhere does the code or the documentation call Study Studio "compliant" or "validated", and this
document does not either.

---

## Overall verdict

**As it stands: no for the ECA's central claim, yes for the multi-site provenance around it.**

- **No.** Study Studio does not help a team defend *how the external comparator was constructed and
  adjusted*, which is the question an ECA lives or dies on. In the federated shape it never sees that
  computation. In the pooled shape it sees one run, but it cannot tell a reviewer which source release
  the comparator came from. It does not hand over the cohort definitions and analysis specification in
  the submission package, and it has no record of amendments or of registration.
- **Yes, materially, for the surrounding layer.** That covers three things:
  - identical, pinned definitions and code at every site, and a run record tying the sealed results to
    those inputs and the pinned packages;
  - per-site CDM and vocabulary versions and a DQD gate pre-specified before any site ran;
  - signed, attributable packs, and a hash-chained record of which sites were adopted or excluded and
    why.

  Reviewers routinely ask for all of these in multi-site RWE, and most teams reconstruct them by hand
  after the fact.
- **What is missing, in order of importance:**
  1. C1, so the package contains what its hashes refer to;
  2. P1 and P3, for the amendment trail and an external anchor for pre-specification;
  3. A1, so sites that drop out leave a trace;
  4. C2 and A3, so source releases and cut-offs are pre-specified and shown;
  5. A2, E1 and X1, so attrition, concept resolution and site heterogeneity are visible rather than
     buried in datasets;
  6. the six wording fixes above.

  All of them are offline, browser-only and need no new dependency. Only X2 touches R. None adds work
  for a site researcher beyond what Strategus and DQD already produce.

Even with all of them in place, Study Studio would make an ECA's inputs, definitions and decisions
**auditable**. Whether the external comparator is a fair comparator remains a scientific and regulatory
judgement made outside the tool.
