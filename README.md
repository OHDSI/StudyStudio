# OHDSI Study Studio

> **Under development.**

A browser-only workspace for running OHDSI network studies. It sits between the study coordinator and participating hospitals. Use it to:

1. **Distribute** a Strategus study with its code and settings pinned by SHA-256.
2. **Check** each site's results for small cells before anything leaves the hospital.
3. **Package** the results into a file whose contents are listed by SHA-256 (a *StudyPack*), optionally signed. A signed pack reveals any later change; an unsigned one only reveals changes made without also rewriting its manifest.
4. **Verify** all the packs centrally, record which sites are adopted and why, and export the results as CDISC Define-XML with Dataset-JSON or SAS V5 transport (XPT) datasets.

A protocol can be issued with **regulatory assurance**, which adds electronic signatures, a pre-specified data-quality gate, CDM / vocabulary traceability, execution logs, a run record and a site-disposition audit trail (see [Regulatory controls](#regulatory-controls)).

There is no server and nothing is sent over the network. `npm run build` produces a single `dist/index.html` that you can copy into a closed hospital network and open from `file://`.

---

## Quick start

A build of `main` is hosted at <https://ohdsi.github.io/StudyStudio/>. It runs entirely in the browser like the local build; the demo files are in [`samples/`](samples/).

```bash
npm install
npm run dev        # open the printed URL
```

Or build the single file and open it directly:

```bash
npm run build      # → dist/index.html
```

## Try it with the demo data (about 5 minutes)

Everything under `samples/` is synthetic. Switch roles with **Site Mode / Admin Mode** in the header.

### 1. Coordinator: issue a protocol
1. **Admin Mode → Protocol Issuer**.
2. Drop `samples/study-repo.zip` (or the files in `samples/study-repo/`).
3. Review the analysis specification summary and fill in the study metadata.
4. Issue the protocol. You get `<studyId>_protocol.zip` and `study_config.json`. Ready-made copies are in `samples/protocol/`.

   The demo uses **Standard** assurance. Choosing **Regulatory** requires a coordinator signing key (**Create a signing key** in the same card).

### 2. Site: build a StudyPack
1. **Site Mode**, then enter a **Site ID** (e.g. `Site_A`).
2. **Step 1:** drop `samples/protocol/ACEI_ANGIO_2026_protocol.zip`. The spec, `ExecuteAnalyses.R` and `renv.lock` are filled in for you.
3. **Step 2:** drop the files in `samples/site/`. They are assigned to slots by file name. For the Strategus results, use either:
   - `strategus_results_Site_A.zip` (the drop zone), or
   - the `strategus_results_Site_A/` folder (**Choose results folder…**).
   `run_record.json` and `executionSettings.json` inside the results folder (or a ZIP of it) are picked up too. `Strategus::zipResults()` keeps only the CSVs, so with its ZIP, drop those two files separately. `strategus-log.txt` goes into the log slot; credentials, hosts and user names in it are redacted by pattern before packing (check the redacted log before sending it).
4. Review **Data quality & provenance evidence** (DQD gate, CDM / vocabulary versions, execution log, run record, time order).
5. **Step 3:** **Download StudyPack**. If anything was masked or redacted, a `*.retention.json` receipt is also available (**Save retention receipt**; saved automatically in regulatory studies): keep it at the site and do not send it.

To see the safety lock, use `samples/site/with_violations/` instead of the matching files in `samples/site/`: the results ZIP or folder, plus its `executionSettings.json`. Then:
- The audit finds small cells and blocks the download.
- A warning says the results were exported with a lower `minCellCount` (0) than the protocol requires (5).
- **One-click auto-masking** fixes the cells (`-5` by default), and the download unlocks.

### 3. Coordinator: verify and export
1. **Admin Mode → Multi-Site Aggregator**. Optionally enter who you are (required in regulatory studies; every receipt and decision is attributed to that person).
2. Drop the four packs in `samples/network/`. Optionally drop `samples/protocol/study_config.json` as well; without it, the majority hash is used as the reference.
3. Expected result:

   | Pack | Result | Why |
   |---|---|---|
   | Site_A | ✅ adopt | clean |
   | Site_B | ✅ adopt | clean (its INPUTS block differs, which is allowed) |
   | Site_C | ❌ exclude | a result file was changed after sealing |
   | Site_D | ❌ exclude | code below the protected marker was edited |

4. **Record recommendations for undecided sites** (or adopt / exclude each site with a pre-specified reason), tick the attestation and **Lock** the dispositions. Every step is in the **Disposition audit trail**.
5. **Export Hub**:
   - **Audit report:** live **Preview**, **Markdown source**, Markdown download, or **PDF (print)**.
   - **Submission package:** choose the Define-XML version and the dataset format (Dataset-JSON v1.1 / v1.0, or XPT: 8-character SAS names, text up to 200 bytes; the format the PMDA validator reads), the CDISC/NCI ADaM CT version (Define-XML 2.1), the target agency and the result tables, then generate the ZIP. The **Define-XML conformance** panel lists any issue found by the built-in checks, rated as the Pinnacle 21 profile of the chosen agency (FDA or PMDA) would rate it, and the validator findings expected by design with an explanation for the reviewer's guide; both are also recorded in the audit report. The agency does not change the package. Which versions an agency accepts is set by its data standards catalog: check it before choosing.
   - **Reviewer's guide (draft):** an Analysis Data Reviewer's Guide structured after the PHUSE ADRG template, filled from the study (standards and versions, sites and dispositions, cohorts and analyses, datasets, conformance issues with explanations, pinned programs and package versions). The parts only the sponsor can write are marked "TO BE COMPLETED". After running your validator on the package, drop its Pinnacle 21 Excel reports under **Validator reports**: sections 6.1 and 6.2 then list each run (engine, configuration, what was validated, CT version, date) and every issue it reported with its severity, explaining the findings expected by design and marking the others for explanation; a report whose datasets do not match the package is flagged. Download it as Markdown, HTML or PDF (print); it is not sealed in the ZIP because it is meant to be completed. It includes the disposition log and each site's manifest, signature and audit report. If the CDISC stylesheet has been placed in `src/lib/cdisc/stylesheets/` before building (see the README there), it is included too, and `define.xml` refers to it.

---

### 4. Regulatory walkthrough (`samples/regulatory/`)
The same study issued with **regulatory** assurance. All demo keys use the passphrase `demo-passphrase-not-secret` (demo only — never reuse these keys).
1. **Site Mode:** drop `regulatory/protocol/ACEI_ANGIO_2026_protocol.zip`; the coordinator signature is verified. Load the files from `samples/site/` as above, then unlock `regulatory/keys/site_a_operator.key.json` in **Electronic signature** and download the signed StudyPack.
2. **Admin Mode → Multi-Site Aggregator:** drop `regulatory/protocol/ACEI_ANGIO_2026_protocol.zip` as the reference, then `regulatory/signer_roster.json` together with `signer_roster.jws.json` (signed by the protocol issuer), enter your name, and drop the four packs in `regulatory/network/`:

   | Pack | Result | Why |
   |---|---|---|
   | Site_A | ✅ adopt | signed by the enrolled operator and the site PI |
   | Site_B | ✅ adopt | signed by the enrolled operator |
   | Site_C | ❌ exclude | signed with a key that is not in the roster |
   | Site_D | ❌ exclude | signed with a key that was revoked before the pack was received (`INTEGRITY`) |

3. Record the recommendations, lock, and export. In a regulatory study the export stays disabled until the dispositions are locked.

To see the data-quality gate stop a site, use `regulatory/site/dqd_results_structural_failure.json` instead of `site/dqd_results.json` in step 1: a required field fails on a table the study uses, and the StudyPack cannot be sealed.

These gates are enforced by the library (`sealRefusals`, `buildRegulatoryExport`), not only by disabled buttons, so no code path in this tool produces a pack or submission that breaks them. A ZIP assembled by hand is caught by the coordinator's verification, not by these gates.

## How it fits with OHDSI Strategus

OHDSI Study Studio does **not** write or run analysis code. Analyses are designed and executed with OHDSI **Strategus** (HADES). OHDSI Study Studio handles everything around that run:

| Who | Tool | What they do |
|---|---|---|
| Study designer | R | Builds the analysis specification JSON (cohorts, negative controls, CohortMethod / SCCS / … modules) |
| Coordinator | 🌐 Protocol Issuer | Pins the spec, execution script and `renv.lock`, and issues the protocol |
| Site | R | `renv::restore()`, fills in the INPUTS block, runs `Strategus::execute()` (wrapped in `recordStrategusRun()`, which writes `run_record.json`) |
| Site | 🏥 Site Mode | Adds DQD / ETL artifacts and the results. Audits, masks and seals them into `[siteId]_[studyId].studypack.zip` |
| Coordinator | 🌐 Aggregator / Export Hub | Verifies the packs, adopts or excludes sites, exports the audit report and CDISC files |

The [StrategusStudyRepoTemplate](https://github.com/ohdsi-studies/StrategusStudyRepoTemplate) layout is recognised but not required. R analyses that do not run through `Strategus::execute()` (for example a script that calls CohortMethod directly) are not supported: results are read as Strategus module folders. A StudyPack is an offline alternative to SFTP upload for sites that cannot reach the internet.

## What gets checked

### Protocol integrity

| File in the pack | How it is compared to the protocol |
|---|---|
| `definitions/analysisSpecifications.json` | SHA-256 of the whole file |
| `code/renv.lock` | SHA-256 of the whole file |
| `code/ExecuteAnalyses.R` | SHA-256 of the code **below** `DO NOT MODIFY BELOW THIS POINT`, so sites can still edit their INPUTS. Without the marker, the whole file is pinned. Any `.R` script that calls `Strategus::execute()` is accepted |

Every file in a pack is also listed with its SHA-256 in `manifest.json`, so a change after sealing is detected unless the manifest is rewritten too. A signature over `manifest.json` closes that gap.

These checks show which files were sealed into the pack. The [run record](#run-record) ties them to the R run that wrote the results, but it is written on the site's machine: it does not prove that the site ran that code, which still rests on the site's own procedures.

### Small cells in Strategus results
- **Input:** results are read as `<Module>/<table>.csv`, from the folder written by `Strategus::execute()` or the ZIP from `Strategus::zipResults()`.
- **What is checked:** the columns that each module's `resultsDataModelSpecification.csv` flags `min_cell_count = Yes`. Values with 0 < n < minCellCount fail. Tables without that file fall back to column-name heuristics. Direct identifier columns are also flagged.
- **Masking:** censored values follow the HADES convention `-minCellCount`, which keeps the columns numeric for the OHDSI results database. `<5` and `NA` are also available.
- **Export settings:** if `executionSettings.json` records a lower `minCellCount` than the protocol, the site is warned before packaging.

### Data quality, provenance and logs
Evaluated at the site, sealed into `audit_report.json`, and evaluated again by the coordinator:
- **DQD gate:** OHDSI Data Quality Dashboard results are judged against a policy that is pinned in the protocol (or derived from the analysis specification). Structural conformance failures and errored checks on the CDM tables the cohorts use block; other failures on those tables warn; failures elsewhere are informational.
- **Provenance:** `DatabaseMetaData/database_meta_data.csv` (cdm_source), DQD metadata and `etl/vocabulary_version.json` must agree, and must meet the protocol's CDM / vocabulary requirements. R and HADES package versions are read from `renv.lock`. Every module in the analysis specification must have results.
- **Execution log:** the Strategus / ParallelLogger log is redacted, then checked for errors, warnings, run times and `minCellCount`.
- **Time:** CDM release, DQD run, Strategus run, seal and receipt must be in a possible order.

### Run record
[`r/recordStrategusRun.R`](r/recordStrategusRun.R) is an R function that wraps `Strategus::execute()`. It is pasted below the protected marker of `ExecuteAnalyses.R`, so the protocol pins it like the rest of that section, and sites run the script as before. In a script without the marker it can go anywhere above the call, and the whole script is compared instead; the script path is taken from `source()` or `Rscript`, else `ExecuteAnalyses.R` in the working directory; pass `executionScriptFile` otherwise:

```r
recordStrategusRun(
  Strategus::execute(analysisSpecifications, executionSettings, connectionDetails),
  resultsFolder = resultsFolder,
  analysisSpecificationsFile = file.path(config$projectRootFolder, "inst", config$studySpecificationFileName),
  executionScriptFile = file.path(config$projectRootFolder, "ExecuteAnalyses.R"),
  renvLockFile = file.path(config$projectRootFolder, "renv.lock")
)
```

It hashes the analysis specification, `renv.lock` and the protected part of the script before the run starts. Right after the run, in the same R session, it appends to `<resultsFolder>/run_record.json`: those hashes, start and end time, whether the run completed (only the error class is kept, because error messages can contain hosts or user names), the R and package versions loaded, and the SHA-256 and modification time of every file in the results folder. If the record cannot be written, R gives a warning and the run's own error, if any, is still raised; an existing record that cannot be read is moved aside (`run_record.invalid-<time>.json`) and a new one is started. The script is hashed from disk, so run it as a whole (`source()` or `Rscript`). Pass the Strategus results folder as `resultsFolder` so the record travels with the results folder (`Strategus::zipResults()` keeps only CSVs, so send `run_record.json` beside its ZIP); if a parent folder is passed, the paths still line up, but `run_record.json` must then be dropped into its slot separately. It needs `jsonlite` and SHA-256 from R ≥ 4.5, `digest` or `openssl`.

OHDSI Study Studio compares the last run in the record with the files being sealed:
- **Inputs:** the specification, `renv.lock` and protected section (or whole script, without the marker) the run used must be the protocol's.
- **Results:** every packed result CSV and `executionSettings.json` must be one the run wrote, unchanged. A file left in the folder by an earlier run (modified before the last run started, on the results folder's own clock, so a network share with a different clock is fine) must have been recorded with the same content by an earlier completed run, as when only some modules are re-run. Masked files are compared through their originals at the site.
- **Environment:** HADES packages loaded in the run must match `renv.lock`; other packages and the R version are warnings.
- **Status and time:** the last run must have completed — `Strategus::execute()` does not stop when a module fails, so each module's status is recorded (without its error message) and a failed or blocked module fails the run — and must have loaded Strategus (a wrapper around anything else is not a study run), and its times join the time-order check.

In a regulatory study a missing record, or any of the above, blocks the pack; in a standard study they are warnings and the record is optional.

A plain hash of a results file that was later masked would let anyone recover the masked values, so the sealed copy withholds those hashes (`"withheld": "masked-at-site"`). The original record stays at the site under a salted commitment, like other masked files. The coordinator therefore cannot compare masked files with the record itself; it sees the site's comparison in `audit_report.json`.

## Regulatory controls

Designed with reference to ICH M14, ICH E6(R3), the FDA RWD and Part 11 Q&A guidances, the EMA computerised-systems guideline and the MHLW/PMDA database-study notices. [`docs/regulatory/requirements.md`](docs/regulatory/requirements.md) maps each requirement to its source and its implementation, and lists the known limitations; the validation plan maps the requirements to the tests that exercise them. [`docs/regulatory/validation-plan.md`](docs/regulatory/validation-plan.md) is a template for validating the tool for a study: risk assessment, data flow, traceability, IQ/OQ/PQ and the SOPs it relies on.

| Control | What it does |
|---|---|
| **Assurance level** | `study_config.assurance`: `standard` (everything below is a warning) or `regulatory` (the rules block, and the data-quality gate, CDM requirements and exclusion reasons are pre-specified in the protocol) |
| **Electronic signatures** | ECDSA P-256 keys generated in the browser and kept as passphrase-protected key files. Detached JWS (ES256) over `manifest.json` and `study_config.json`, showing name, role, time, time zone and meaning. Verifiable with standard JOSE libraries that support detached payloads |
| **Signer roster** | The coordinator enrolls each site's public key after verifying identity out of band, then signs the roster with the key that issued the protocol. Only enrolled, unrevoked keys in a roster signed that way count; revocation is judged against the coordinator's receipt time |
| **Originals of modified files** | Masked results and redacted logs carry a salted commitment to the original (a plain hash would let anyone brute-force the masked values). The salts stay at the site in a retention receipt |
| **Run record** | `recordStrategusRun()` records what the R run read and wrote; the pack must match it (see [Run record](#run-record)). Required in regulatory studies. It is written on the site's machine, so it detects changes between run and seal and runs that did not use the protocol's inputs, not deliberate fabrication |
| **Disposition audit trail** | Every receipt, adoption, exclusion, lock and export is a hash-chained entry with who / when / old → new / why; edits, removals and truncation are detectable as long as the exported head is kept outside the tool. Exclusions need a pre-specified reason code. In regulatory studies the dispositions must be locked, with the coordinator's attestation that comparative results were not viewed (the tool records it but cannot verify it), before the submission package is generated |

Offline there is no trusted clock, no two-factor login and no single place to keep a log; the requirements document says how each gap is mitigated and what belongs in the study's SOPs.

## StudyPack layout
```
<studyId>-pack/
├── manifest.json                 # SHA-256 of every file (+ salted commitments to masked/redacted originals)
├── manifest.jws.json             # signatures over manifest.json (when signed)
├── ro-crate-metadata.json        # RO-Crate 1.1
├── audit_report.json             # site self-audit: small cells / identifiers, protocol checks, DQD gate, provenance, log, run record, time, modifications
├── protocol/study_config.json    # the protocol exactly as received (+ study_config.jws.json)
├── etl/                          # ScanReport_sanitized.xlsx, mapping_specification.json, vocabulary_version.json
├── evidence/dqd_results.json
├── evidence/run_record.json      # run record from recordStrategusRun() (hashes of masked files withheld)
├── definitions/analysisSpecifications.json
├── code/ExecuteAnalyses.R, renv.lock, executionSettings.json
├── logs/execution.log            # redacted Strategus log
└── results/<ModuleName>/*.csv    # Strategus results (+ resultsDataModelSpecification.csv per module)
```

Kept at the site, never sent: `<siteId>_<studyId>.retention.json` (salts and hashes of the originals).

## Zero transmission
- **CSP:** the production build injects a CSP with `connect-src 'none'`, `form-action 'none'` and `frame-src 'none'`, so the browser itself refuses fetch, XHR, WebSocket and beacons.
- **Runtime guard:** `src/lib/security/networkGuard.ts` also disables `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon`.
- **In memory only:** hashing uses the Web Crypto API, ZIPs use JSZip, Excel uses SheetJS and CSV uses PapaParse.

---

## Development
```bash
npm run dev        # dev server (no CSP, so HMR works)
npm test           # vitest
npm run typecheck
npm run build      # single-file dist/index.html
npm run samples    # regenerate samples/ (scripts/make-samples.ts)
Rscript r/tests/test-recordStrategusRun.R   # the R run-record function (needs jsonlite, R >= 4.5)
Rscript r/tests/cross-check.R /tmp/rr && STUDYSTUDIO_R_RECORD=/tmp/rr npx vitest run src/lib/strategus/runRecord.r.test.ts
                                            # a record written by R, checked by the TypeScript code
```

Every push to `main` runs the tests, builds `dist/` and deploys it to GitHub Pages (`.github/workflows/pages.yml`). Pushes and pull requests also run the R tests and the R-to-TypeScript check (`.github/workflows/r-run-record.yml`). `.github/workflows/strategus-eunomia.yml`, started by hand, runs a real Strategus study on Eunomia through `recordStrategusRun()` (a full run and a `skipCompletedTasks` re-run) and checks the record the same way; a second site runs it on a reduced copy of Eunomia with its own INPUTS block. It then seals each site's results as a StudyPack, adopts both and exports them as the Export Hub does: define.xml v2.1 and v2.0 (built-in checks and the CDISC schemas) with Dataset-JSON (every table) and with XPT (the result tables), the audit report and the draft reviewer's guide, which are uploaded with the run for review.

### Demo data reference (`samples/`)

| Path | Contents |
|---|---|
| `study-repo/`, `study-repo.zip` | Strategus study repository (template layout) for Protocol Issuer |
| `protocol/` | Issued protocol: `study_config.json`, `ACEI_ANGIO_2026_protocol.zip` |
| `site/` | Clean Site Mode inputs, including DQD results and a Strategus log. Results come as both a ZIP and an expanded folder, each with `executionSettings.json` and `run_record.json` |
| `site/with_violations/` | Uncensored results (ZIP and folder) plus `executionSettings.json` with `minCellCount: 0` |
| `network/` | Four StudyPacks: Site_A and Site_B clean, Site_C tampered, Site_D with edited protected code |
| `regulatory/` | Regulatory-assurance set: signed protocol, demo keys (`keys/`, passphrase `demo-passphrase-not-secret`), signed signer roster, four signed packs |
| `templates/` | Source files used by `npm run samples` |
| `atlas_cohorts.json` | ATLAS cohort definitions the sample analysis specification is generated from (`npm run samples`) |

The sample `renv.lock` and result values are illustrative. They are not a tested HADES release set.

### Code layout
```
r/recordStrategusRun.R           R function that writes run_record.json after Strategus::execute()
src/lib/strategus/               analysis spec, protected section of the execution script, results + RDMS audit, run record, protocol issuance
src/lib/audit/                   small-cell / identifier audit + masking, DQD gate, execution-log audit + redaction
src/lib/integrity/               SHA-256 (Web Crypto), salted commitments
src/lib/security/                zero-network guard, key files + JWS signatures + signer roster
src/lib/provenance/              cdm_source / vocabulary / software provenance, time evidence
src/lib/studypack/               slots, readiness checks, evidence, pack builder (manifest, RO-Crate, audit_report)
src/lib/network/                 pack verification, cross-site hash checks, DQD summary, disposition audit trail
src/lib/cdisc/                   Define-XML v2.1/v2.0, Dataset-JSON v1.1/v1.0, SAS V5 transport (XPT), ScanReport / mapping parsers
src/lib/export/                  audit reports (+ Markdown preview parser), regulatory submission ZIP
src/store/useStudyStore.ts       Zustand store
src/features/{site,admin}/       screens
```

## Limitations
- **CDISC validation:** the tests check that the Define-XML output is well-formed XML and that both outputs have the expected structure. This repository does **not** validate them against the official CDISC schemas (Define-XML XSD, Dataset-JSON JSON Schema), and they have **not** been run through Pinnacle 21. OMOP / Strategus tables are not SDTM/ADaM, so expect conformance-rule warnings.
- **Define-XML v2.0:** non-standard datasets cannot be flagged, so its XSD does not check Origin Type terminology.
- **Large results:** big Strategus outputs (e.g. covariate balance) are parsed on the main thread. Use the Export Hub table selection to keep submissions focused; the tables that copy the analysis specification (cohort definitions, analysis settings) are not selected by default.

## License
Apache License 2.0. See [LICENSE](LICENSE).
