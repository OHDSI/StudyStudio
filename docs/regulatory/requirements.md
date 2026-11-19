# Regulatory requirements traceability

This document maps the principles in regulatory guidance to the OHDSI Study Studio features designed to meet them. Every requirement ID below
names the module that implements it; [validation-plan.md](validation-plan.md) §6 names the tests that
exercise it. It is an input to the validation of the tool for a given study, not a substitute for it.
The requirements below are our reading of the sources, not demands made of this tool: no regulator asks for
these mechanisms as such, and no regulator has reviewed the tool.

**Status of the sources.** None of these documents is written for OHDSI-style distributed network
studies, and most of them are non-binding guidance ("should"). ICH E6(R3) and the EMA computerised
systems guideline apply to interventional trials; we use them as the benchmark for data integrity
because ICH M14 and the FDA RWD guidance point to the same principles without giving technical detail.
Whether a hospital running Strategus counts as a "DB事業者" under the Japanese notices is our
interpretation and should be confirmed in a PMDA consultation.

## Sources (consulted November 2026)

| Key | Document | Version |
|---|---|---|
| M14 | ICH M14 *General Principles on Planning, Designing, Analysing, and Reporting of Non-interventional Studies That Utilise Real-World Data for Safety Assessment of Medicines* | Final, adopted 04 Sep 2025 |
| E6 | ICH E6(R3) *Guideline for Good Clinical Practice* | Final, adopted 06 Jan 2025 (scope: interventional trials) |
| FDA-RWD | FDA *Real-World Data: Assessing Electronic Health Records and Medical Claims Data to Support Regulatory Decision-Making for Drug and Biological Products* | July 2024 |
| FDA-DS | FDA *Data Standards for Drug and Biological Product Submissions Containing Real-World Data* | December 2023 |
| FDA-P11 | FDA *Electronic Systems, Electronic Records, and Electronic Signatures in Clinical Investigations: Questions and Answers* | October 2024, Revision 1 |
| EMA-CS | EMA *Guideline on computerised systems and electronic data in clinical trials* (EMA/INS/GCP/112288/2023) | Adopted 07 Mar 2023 |
| JP-DB | 医薬品の製造販売後データベース調査における信頼性担保に関する留意点について（薬生薬審発0221第1号） | 平成30年2月21日 |
| JP-QA | レジストリ又は医療情報データベースのデータを医薬品の承認申請、再審査等申請に利用する場合の信頼性担保に係る留意点に関する質疑応答集（Ｑ＆Ａ） | 令和4年9月14日、令和8年3月30日一部改訂 |
| JP-ERES | 医薬品等の承認又は許可等に係る申請等における電磁的記録及び電子署名の利用について（薬食発第0401022号）別紙「医薬品等の承認又は許可等に係る申請等に関する電磁的記録・電子署名利用のための指針」（ER/ES指針） | 平成17年4月1日 |
| JP-EDOC | 治験関連文書における電磁的記録の活用に関する基本的考え方について（厚生労働省医薬食品局審査管理課事務連絡） | 平成25年7月1日 |

## Design constraints that shape every answer

- **No network.** No TSA, no IdP, no certificate authority can be reached at the site.
- **No persistent storage.** The tool keeps nothing between sessions. Anything that must last is a file
  the user saves; anything that must not be lost is chained or signed so that loss is detectable.
- **Assurance level is a protocol choice.** `study_config.assurance` is `standard` (academic OHDSI studies:
  everything optional, warnings only) or `regulatory` (the rules below become blocking). This keeps the
  convention free for studies that do not need it.

## Requirements

### R1 — Attributable: who sealed / approved / decided

| ID | Requirement | Source | Implementation |
|---|---|---|---|
| R1.1 | Signed records show printed name, date/time, and meaning of the signature | FDA-P11 §III.E (21 CFR 11.50); JP-ERES 4.(3); EMA-CS §4.8 (date, time and time zone) | `security/signer.ts` protected header `sp:signer`, `sp:signedAt`, `sp:meaning`, `sp:statement` |
| R1.2 | Signature is linked to the record so it cannot be excised or reused; any change visibly invalidates it | FDA-P11 §III.E (11.70); EMA-CS §4.8; JP-ERES 4.(4) | Detached JWS (ES256) over the exact bytes of `manifest.json`, which lists the SHA-256 of every file |
| R1.3 | Signature records the time zone (or UTC) | EMA-CS §4.8; FDA-P11 Q14 | `sp:signedAt` is ISO-8601 UTC with `sp:tzOffsetMinutes` |
| R1.4 | Two distinct identification components for non-biometric signatures | 21 CFR 11.200(a)(1); FDA-P11 §III.E (repeated signings); EMA-CS A4.12 (two-factor: something you know + something you have, e.g. a certificate) | Key file (something you have) + passphrase (something you know), both required at every signing; private key never stored unencrypted. Account lockout and inactivity logout (EMA-CS A4.12, A4.17) do not apply to a tool without accounts — documented limitation 2 |
| R1.5 | Identity verified before a signer is enrolled; record of who may sign, when added/revoked | FDA-P11 Q11, Q26; EMA-CS §5.4, A3 | `signer_roster.json` (kid, name, role, organisation, siteId, enrolledAt, verifiedBy, method, revokedAt), signed by the protocol issuer's key (`roster-approved`) and checked by the Aggregator; any edit voids that signature. Revocation is judged against the coordinator's receipt time, not the signer's clock. Verification itself is an SOP |
| R1.6 | No method is mandated; PKI not required; the signature function should be proven during validation (EMA-CS §4.8, closed systems; FDA-P11 Q24: validation "when warranted"). The tool is a **closed system** in EMA's sense: the coordinator verifies every signer's identity before enrolling the key in the signed roster and controls who may sign, so eIDAS does not apply (EMA-CS §4.8, eIDAS art. 2.2) | FDA-P11 Q24, Q28; EMA-CS §4.8 | Standard JOSE format (RFC 7515/7518/7638) so signatures verify outside the tool; unit tests with fixed vectors |

### R2 — Contemporaneous: time

| ID | Requirement | Source | Implementation |
|---|---|---|---|
| R2.1 | Times are unambiguous: UTC or time + time zone | E6 §4.2.2(d); FDA-P11 Q14; EMA-CS §5.5 | All recorded times ISO-8601 UTC + local offset |
| R2.2 | Clock set by an external standard, not user-modifiable; discrepancies detected and reported | EMA-CS §5.5; FDA-P11 Q14; JP-ERES 2.(6) | **The device's clock, controlled by procedure** — the approach both texts describe. SOP-3: seal and receive on institution-managed workstations synchronised to an external standard (e.g. NTP), where only administrators can change the clock and changes are documented. The tool runs in the browser and cannot verify this. It helps in two ways: `provenance/deviceClock.ts` warns when a loaded file is dated in the device's future (the clock runs behind; FDA Q14 asks that discrepancies be detected); `provenance/timeline.ts` labels every time by source (`coordinator-signed`, `device-clock`, `derived`), bounds the seal between protocol issue and coordinator receipt, and checks ordering (CDM release ≤ DQD ≤ Strategus run ≤ seal ≤ receipt). |
| R2.3 | Transfer time is recorded | EMA-CS §4.5 (ALCOA++ “contemporaneous”: time of observation and of storage kept as metadata); FDA-P11 Q8 (records not altered during transfer); FDA-P11 Q22 by analogy (transfer time from a DHT in the audit trail) | Aggregator records receipt time in the disposition log; the pack carries its seal time |

### R3 — Traceable provenance: CDM, vocabulary, software versions

| ID | Requirement | Source | Implementation |
|---|---|---|---|
| R3.1 | Coding systems and their versions are documented; changes over time are addressed | M14 §5.3, §5.3.2; FDA-RWD §IV.A, §VI.A; JP-DB 別添3 | `provenance/cdmSource.ts` reads `DatabaseMetaData/database_meta_data.csv`, DQD metadata and `etl/vocabulary_version.json`, cross-checks them and the protocol's `cdmRequirements` |
| R3.2 | Transformation into a CDM is documented | FDA-RWD §VI.A; FDA-DS §III.C | Existing ETL slots (`ScanReport`, mapping specification) + CDM facts in the audit report |
| R3.3 | Software and versions are recorded to allow replication | M14 §6.1, §7; EMA-CS §4.7 (traceability of data transformations and derivations) | R and HADES package versions from `renv.lock`, tool name, version and build id (the git commit, set by `vite.config.ts` at build time) in `manifest.json` |
| R3.4 | All planned analyses produced results (completeness) | E6 §4.2.6; M14 §7 | Modules in the analysis specification vs. modules present in the results |

### R4 — Data quality gate

| ID | Requirement | Source | Implementation |
|---|---|---|---|
| R4.1 | Data are characterised for completeness, conformance and plausibility | FDA-RWD §VI | DQD results (`evidence/dqd_results.json`) are required in `regulatory` mode |
| R4.2 | QA/QC criteria are pre-specified before analysis; adding QC after seeing results is inappropriate | M14 §6; FDA-RWD §VI.B; JP-QA Q7 | Gate policy lives in `study_config.dataQuality` and is pinned by the protocol; its hash is written into the audit report |
| R4.3 | Data-model conformance errors are checked | FDA-RWD §VI.A(6) | Structural conformance failures (`cdmTable`, `cdmField`, `cdmDatatype`, `isRequired`, `isPrimaryKey`, `isForeignKey`) on study tables **block** |
| R4.4 | Risk-based: focus on data critical to the study | M14 §6.2.3; E6 §4.2 | Study tables are derived from the cohort definitions; other failures warn or inform |
| R4.5 | A full data-quality report is retained, not only pass/fail | FDA-RWD §VI | `dqd_results.json` is packed as-is; per-check findings in the audit report |

### R5 — Complete and original: logs and modified files

| ID | Requirement | Source | Implementation |
|---|---|---|---|
| R5.1 | Records showing the analysis dataset and results were produced correctly are retained | JP-DB 3.(4); JP-QA Q35 | Execution log slot `logs/execution.log` (required in `regulatory` mode); `audit/logAuditor.ts` counts errors/warnings and extracts run times |
| R5.2 | Changes do not obscure the original; the reason is recorded | FDA-P11 Q12; E6 §4.2.2; EMA-CS §6.2 | Every masked or redacted file records rule, reason, counts and a **salted commitment** to the original |
| R5.3 | Privacy: the record of the original must not leak the suppressed values | M14 §10; E6 §2 | Commitment = SHA-256(salt ‖ original). A plain hash of the original would let anyone brute-force the masked 1…(n−1) values. The salt stays at the site in a retention receipt |
| R5.4 | Originals are retained at the source and available on request | EMA-CS §6.11; JP-QA Q9 (retention per 薬機法施行規則 第43条/第61条) | `*.retention.json` receipt (salts, original hashes, pack hash) is saved separately and kept at the site; a redacted copy is labelled as a derived copy, not a certified copy (FDA-P11 Q3) |
| R5.5 | The record shows that the results were produced by the specified analysis, from the specified inputs and software | JP-DB 3.(4); JP-QA Q35; M14 §7 | `r/recordStrategusRun.R` wraps `Strategus::execute()` below the protected marker and, in the same R session, appends `run_record.json` to the results folder (inputs, loaded package versions, SHA-256 of every results file, completion status; no error messages). `strategus/runRecord.ts` compares the last run with the sealed files: inputs vs. the protocol's specification, `renv.lock` and protected section (the whole script when it has no marker); each packed result CSV and `executionSettings.json` vs. what the run wrote (masked files through their originals at the site); loaded HADES packages vs. `renv.lock`; the last run must have completed (every module succeeded or was skipped as already completed) and loaded Strategus, and each packed result must have been written by it or by an earlier completed run with the same content (file modification times). Required and blocking in `regulatory` mode, re-checked by the coordinator. `network/plausibility.ts` compares the sites for traces of copied or edited results (for review, never blocking). Hashes of masked files are withheld in the sealed copy (R5.3). The record is written on the site's machine (limitation 7) |

### R6 — Site disposition audit trail (selection bias)

| ID | Requirement | Source | Implementation |
|---|---|---|---|
| R6.1 | Exclusion criteria are pre-defined; the rationale for each exclusion is documented | E6 §3.16.2(d); M14 §4.2 | `study_config.adoptionPolicy.reasonCodes`; exclusions and overrides require a pre-specified code (and free text for overrides / `OTHER`) |
| R6.2 | Audit trail: who (user, role, organisation), when, what (old → new), why; protected from change | FDA-P11 Q12; EMA-CS §6.2.1; E6 §4.2.2 | `network/dispositionLog.ts`: append-only JSONL, each entry carries the SHA-256 of the previous line; the head is signed when a coordinator key is unlocked at export |
| R6.3 | Decisions are made without comparing outcomes between groups | M14 §4.2 | Disposition must be **locked** (with an attestation) and every site decided before the submission package is generated in `regulatory` mode; enforced inside `buildRegulatoryExport`. The tool records the attestation; it cannot verify that results were not viewed |
| R6.4 | The audit trail is exportable, human-readable and kept with the data | EMA-CS §6.2.1, §6.10; FDA-P11 Q12 | Log exported in the submission package and rendered in the audit report; can be re-imported and verified to continue a session. EMA-CS §6.2.1 expects the audit trail to be stored within the system; the tool keeps no state, so the log is a file protected by its hash chain and a signed head retained in the TMF (justified deviation, limitation 3) |
| R6.5 | Exports are themselves logged | EMA-CS §6.2.1 | `export` entries in the disposition log |
| R6.6 | The participating data sources are specified in advance, and a site that drops out stays visible | M14 §4.2 (selection of data sources), §7 (reporting of participants) | `study_config.sites` (site ID, role, CDM source name, source release date), signed with the protocol and required at issue in `regulatory` mode (`issueRefusals()`); `siteListMismatches()` compares each pack's `cdm_source` with its entry (`CDM_REQUIREMENT` exclusion in `regulatory` mode, a warning otherwise); a `not-received` disposition entry (pre-specified reason, justification, no pack) records a listed site that sent nothing, and in `regulatory` mode the lock and `buildRegulatoryExport()` require every listed site to have a decision or such an entry (`unaccountedSites()`). The audit report and reviewer's guide show the role, the source release date and the data cut-off (`max_obs_period_end_date`) per site |

### JP-ERES — the Japanese ER/ES guideline, clause by clause

JP-ERES applies to application materials and their source records kept as electronic records, and JP-EDOC
confirms it applies to trial documents too. It states general requirements and leaves the concrete means to
the record holder (JP-EDOC 2.(4)), and authenticity can be established by the system *and* its operating
procedures together. This is why most rows below are addressed by the tool plus an SOP, without extra steps for
site researchers.

| Clause | Requirement (summary) | How the tool addresses it |
|---|---|---|
| 3.1 | Computer system validation is a precondition | [validation-plan.md](validation-plan.md) (risk assessment, automated suite, OQ/PQ, change control) |
| 3.1.1 真正性 (1) | Security rules and procedures documented and followed | SOP-2 (keys and passphrases), SOP-8 (workstation and file handling); the tool sends nothing (`connect-src 'none'`) |
| 3.1.1 真正性 (2) | Creator identifiable; a change keeps the previous content and identifies who changed it; automatic audit trail preferred | Signed manifest names the sealer (R1.1); masked/redacted files keep a salted commitment to the original, which stays at the site with the retention receipt (R5.3, R5.4), and each change is listed in `audit_report.json` with its reason; coordinator decisions in the hash-chained disposition log (R6). JP-EDOC 3.(1)③ accepts operation records kept by procedure where the audit trail is not automatic (パブリックコメント回答 69) |
| 3.1.1 真正性 (3) | Backup procedure documented and followed | SOP-4 (copies of sealed packs, retention receipts, the disposition log and its head) |
| 3.1.2 見読性 | Content can be output in human-readable form (screen, paper, copy) | Audit report (Markdown/HTML, printable), CSVs, define.xml with stylesheet, reviewer's guide |
| 3.1.3 保存性 | Kept readable and authentic for the retention period, including after migration to other media | SOP-4; SHA-256 in `manifest.json` lets a migrated copy be re-verified at any time, with any tool |
| 3.2 / 3.3 | Open systems (records sent outside the holder's control, e.g. by e-mail or USB) need extra means such as encryption or digital signatures for authenticity from creation to receipt | Detached digital signature over `manifest.json` (required in `regulatory` mode); the receipt is recorded with the pack's SHA-256. JP-EDOC 3.(1)④: a digital signature is not required for every trial document (パブリックコメント回答 62); here it is the means 3.3 asks for, because packs travel by open channels |
| 4.(1) | Signature procedures documented under the Electronic Signatures Act | SOP-1 (identity verification, enrollment, revocation), SOP-2 |
| 4.(2) | Each signature unique to one person, never reused or reassigned | One key per person, created in the browser and protected by the person's passphrase; the roster binds the key ID (its public-key thumbprint) to one named person; SOP-2 forbids sharing |
| 4.(3) | Signed record shows signer's name, date/time and meaning | R1.1, R1.3 |
| 4.(4) | Signature linked to its record so it cannot be removed or copied by ordinary means | R1.2 (signature over the exact bytes of `manifest.json`; any change or transplant fails verification) |
| 2.(6) | Audit trail: operation records with accurate, computer-generated time stamps | Times generated by the tool from the device clock in UTC with offset; clock control per SOP-3 (R2.2) |
| 5 | Responsible persons, administrators, organisation, equipment and training defined | [validation-plan.md](validation-plan.md) §4 (roles), SOP-8 (training, workstations) |

JP-EDOC 3.(1)③ also describes send and receipt records (送付簿・受領簿: who, when, what). The coordinator's
disposition log records every receipt with the receiver, time and the pack's SHA-256; at the site, the
sealed pack (signed manifest with sealer and seal time) is kept as the record of what was sent (SOP-4).

## Where the gates are enforced

Every condition that stops a pack from being sealed or a submission from being generated is checked inside the
library, not only in the UI: `sealRefusals()` / `buildStudyPack()` (small cells, and in regulatory studies the
signature, sealed protocol, coordinator signature and blocking evidence) and `buildRegulatoryExport()`
(lock and recorded decisions). Unit tests cover these refusals, so a change that removed one would fail the test suite.

## Known limitations (state them in the study's data management plan)

1. Seal and signature times come from the site's device clock (R2.2). That the clocks are synchronised and
   not changeable by users rests on SOP-3; the tool cannot verify it and only warns when a loaded file is dated
   in the device's future. The window the seal time lies in is [protocol issue time, coordinator receipt
   time], on the coordinator's device clock.
2. Account controls (lockout after failed attempts, inactivity logout) do not exist in a single offline HTML
   file without accounts. Signing requires the key file (something you have) and the passphrase (something you
   know) every time, which is two-factor in EMA's definition (EMA-CS A4.12).
3. The disposition audit trail is a file, not stored within a system (EMA-CS §6.2.1 expects the latter).
   Its hash chain detects alteration and truncation only when its signed head is retained outside the
   tool (e.g. in the TMF). The coordinator could start a new log; the head exported with each package
   is the anchor.
4. DQD checks the CDM's internal consistency. It does not replace the source-to-CDM reconciliation that
   JP-QA Q24 asks of the database holder.
5. The CDISC export contains aggregate Strategus results. It is not SDTM/ADaM and is not presented as
   §745A-conformant study data (FDA-DS).
6. The tool's own validation package (risk assessment, test evidence, change control — FDA-P11 Q7,
   EMA-CS Annex 2, E6 §4.3.4) is maintained per study; [validation-plan.md](validation-plan.md) is the template.
7. The run record (R5.5) is written by R on the site's machine. It detects results that changed between the
   run and the seal, and runs that used other inputs or package versions; it cannot rule out a record
   produced some other way. The Aggregator's plausibility checks look for traces of copied or edited results
   (counts shared with another site, the same database or DQD run, counts that cannot occur together); they are
   for review and catch careless copying, not a careful fabrication. The study's SOPs should cover how runs are
   witnessed or re-executed on a sample ([validation-plan.md](validation-plan.md) §9.1).
   Masked results are compared with the record at the site only: their hashes are withheld in the sealed
   copy (R5.3), so for those files the coordinator relies on the site's audit report (signed in `regulatory` mode).
   The script is hashed from disk: code run line by line from an unsaved editor is not what the record shows.
8. R script studies (a single script such as `CodeToRun.R`, no Strategus) are standard assurance only: there is
   no run record, data-quality gate or execution log, so nothing ties the sealed CSVs to a run of the pinned
   script. When a result holds only relative values (e.g. percentages), the small-cell audit has no count column
   to check; the script itself must suppress small counts.
