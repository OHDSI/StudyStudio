# Regulatory requirements traceability

This document maps regulatory expectations to OHDSI Study Studio features. It is the basis for the
tool's own validation evidence: every requirement ID below names the module that implements it and the
test that demonstrates it.

**Status of the sources.** None of these documents is written for OHDSI-style distributed network
studies, and most of them are non-binding guidance ("should"). ICH E6(R3) and the EMA computerised
systems guideline apply to interventional trials; we use them as the benchmark for data integrity
because ICH M14 and the FDA RWD guidance point to the same principles without giving technical detail.
Whether a hospital running Strategus counts as a "DB事業者" under the Japanese notices is our
interpretation and should be confirmed in a PMDA consultation.

## Sources (read in full, November 2026)

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
| R1.1 | Signed records show printed name, date/time, and meaning of the signature | FDA-P11 §III.E (21 CFR 11.50); EMA-CS §4.8 | `security/signer.ts` protected header `sp:signer`, `sp:signedAt`, `sp:meaning`, `sp:statement` |
| R1.2 | Signature is linked to the record so it cannot be excised or reused; any change visibly invalidates it | FDA-P11 §III.E (11.70); EMA-CS §4.8 | Detached JWS (ES256) over the exact bytes of `manifest.json`, which lists the SHA-256 of every file |
| R1.3 | Signature records the time zone (or UTC) | EMA-CS §4.8; FDA-P11 Q14 | `sp:signedAt` is ISO-8601 UTC with `sp:tzOffsetMinutes` |
| R1.4 | Two distinct identification components for non-biometric signatures | FDA-P11 §III.E (11.200) | Key file (possession) + passphrase (knowledge); private key never stored unencrypted. *Two-factor at login (EMA-CS A4.12) is not achievable offline — documented limitation* |
| R1.5 | Identity verified before a signer is enrolled; record of who may sign, when added/revoked | FDA-P11 Q11, Q26; EMA-CS §5.4, A3 | `signer_roster.json` (kid, name, role, organisation, siteId, enrolledAt, verifiedBy, method, revokedAt), checked by the Aggregator. Revocation is judged against the coordinator's receipt time, not the signer's clock. Verification itself is an SOP |
| R1.6 | No method is mandated; PKI not required; the method must be validated | FDA-P11 Q24, Q28; EMA-CS §4.8 | Standard JOSE format (RFC 7515/7518/7638) so signatures verify outside the tool; unit tests with fixed vectors |

### R2 — Contemporaneous: time

| ID | Requirement | Source | Implementation |
|---|---|---|---|
| R2.1 | Times are unambiguous: UTC or time + time zone | E6 §4.2.2(d); FDA-P11 Q14; EMA-CS §5.5 | All recorded times ISO-8601 UTC + local offset |
| R2.2 | Clock set by an external standard, not user-modifiable | EMA-CS §5.5; FDA-P11 Q14 | **Not achievable offline.** Mitigation: `provenance/timeline.ts` labels every time by source (`coordinator-signed`, `device-clock`, `derived`), bounds the seal between protocol issue and coordinator receipt, and checks ordering (CDM release ≤ DQD ≤ Strategus run ≤ seal ≤ receipt) |
| R2.3 | Transfer time is recorded | FDA-P11 Q22; EMA-CS A1 | Aggregator records receipt time in the disposition log |

### R3 — Traceable provenance: CDM, vocabulary, software versions

| ID | Requirement | Source | Implementation |
|---|---|---|---|
| R3.1 | Coding systems and their versions are documented; changes over time are addressed | M14 §5.3, §5.3.2; FDA-RWD §IV.A, §VI.A; JP-DB 別添3 | `provenance/cdmSource.ts` reads `DatabaseMetaData/database_meta_data.csv`, DQD metadata and `etl/vocabulary_version.json`, cross-checks them and the protocol's `cdmRequirements` |
| R3.2 | Transformation into a CDM is documented | FDA-RWD §VI.A; FDA-DS §III.C | Existing ETL slots (`ScanReport`, mapping specification) + CDM facts in the audit report |
| R3.3 | Software and versions are recorded to allow replication | M14 §6.1, §7; FDA-P11 Q7; EMA-CS A2.10 | R and HADES package versions from `renv.lock`, tool version + build id in `manifest.json` |
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

### R6 — Site disposition audit trail (selection bias)

| ID | Requirement | Source | Implementation |
|---|---|---|---|
| R6.1 | Exclusion criteria are pre-defined; the rationale for each exclusion is documented | E6 §3.16.2(d); M14 §4.2 | `study_config.adoptionPolicy.reasonCodes`; exclusions and overrides require a pre-specified code (and free text for overrides / `OTHER`) |
| R6.2 | Audit trail: who (user, role, organisation), when, what (old → new), why; protected from change | FDA-P11 Q12; EMA-CS §6.2.1; E6 §4.2.2 | `network/dispositionLog.ts`: append-only JSONL, each entry carries the SHA-256 of the previous line; the head is signed |
| R6.3 | Decisions are made without comparing outcomes between groups | M14 §4.2 | Disposition must be **locked** (with an attestation) before the submission package is generated in `regulatory` mode |
| R6.4 | The audit trail is exportable, human-readable and kept with the data | EMA-CS §6.2.1, §6.10; FDA-P11 Q12 | Log exported in the submission package and rendered in the audit report; can be re-imported and verified to continue a session |
| R6.5 | Exports are themselves logged | EMA-CS §6.2.1 | `export` entries in the disposition log |

## Known limitations (state them in the study's data management plan)

1. Seal and signature times come from the site's device clock (R2.2). The trustworthy window is
   [protocol issue time, coordinator receipt time].
2. Login-level controls (two-factor, lockout, inactivity logout) do not exist in a single offline HTML
   file. Signing requires the key file and passphrase every time instead.
3. A hash chain detects alteration and truncation only when its signed head is retained outside the
   tool (e.g. in the TMF). The coordinator could start a new log; the head exported with each package
   is the anchor.
4. DQD checks the CDM's internal consistency. It does not replace the source-to-CDM reconciliation that
   JP-QA Q24 asks of the database holder.
5. The CDISC export contains aggregate Strategus results. It is not SDTM/ADaM and is not presented as
   §745A-conformant study data (FDA-DS).
6. The tool's own validation package (risk assessment, test evidence, change control — FDA-P11 Q7,
   EMA-CS Annex 2, E6 §4.3.4) is maintained separately; this document and the test suite are inputs to it.
