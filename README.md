# OHDSI Study Studio

A browser-only workspace for running OHDSI network studies. It sits between the study coordinator and participating hospitals. Use it to:

1. **Distribute** a Strategus study with its code and settings pinned by SHA-256.
2. **Check** each site's results for small cells before anything leaves the hospital.
3. **Package** the results into a tamper-evident file (a *StudyPack*), optionally signed.
4. **Verify** all the packs centrally, record which sites are adopted and why, and export CDISC Define-XML / Dataset-JSON for regulators.

A protocol can be issued with **regulatory assurance**, which adds electronic signatures, a pre-specified data-quality gate, CDM / vocabulary traceability, execution logs and a site-disposition audit trail (see [Regulatory controls](#regulatory-controls)).

There is no server and nothing is sent over the network. `npm run build` produces a single `dist/index.html` that you can copy into a closed hospital network and open from `file://`.

---

## Quick start

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
   `strategus-log.txt` goes into the log slot; credentials, hosts and user names in it are redacted before packing.
4. Review **Data quality & provenance evidence** (DQD gate, CDM / vocabulary versions, execution log, time order).
5. **Step 3:** **Download StudyPack**. If anything was masked or redacted, a `*.retention.json` receipt is saved too: keep it at the site and do not send it.

To see the safety lock, use `samples/site/with_violations/` instead of the matching files in `samples/site/`: the results ZIP or folder, plus its `executionSettings.json`. Then:
- The audit finds small cells and blocks the download.
- A warning says the results were exported with a lower `minCellCount` (0) than the protocol requires (5).
- **One-click auto-masking** fixes the cells (`-5` by default), and the download unlocks.

### 3. Coordinator: verify and export
1. **Admin Mode → Multi-Site Aggregator**, and enter who you are (every receipt and decision is attributed to you).
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
   - **Submission package:** choose the Define-XML / Dataset-JSON versions and the result tables, then generate the ZIP. It includes the disposition log and each site's manifest, signature and audit report.

---

## How it fits with OHDSI Strategus

OHDSI Study Studio does **not** write or run analysis code. Analyses are designed and executed with OHDSI **Strategus** (HADES). OHDSI Study Studio handles everything around that run:

| Who | Tool | What they do |
|---|---|---|
| Study designer | R | Builds the analysis specification JSON (cohorts, negative controls, CohortMethod / SCCS / … modules) |
| Coordinator | 🌐 Protocol Issuer | Pins the spec, execution script and `renv.lock`, and issues the protocol |
| Site | R | `renv::restore()`, fills in the INPUTS block, runs `Strategus::execute()` |
| Site | 🏥 Site Mode | Adds DQD / ETL artifacts and the results. Audits, masks and seals them into `[siteId]_[studyId].studypack.zip` |
| Coordinator | 🌐 Aggregator / Export Hub | Verifies the packs, adopts or excludes sites, exports the audit report and CDISC files |

The [StrategusStudyRepoTemplate](https://github.com/ohdsi-studies/StrategusStudyRepoTemplate) layout is recognised but not required. A StudyPack is an offline alternative to SFTP upload for sites that cannot reach the internet.

## What gets checked

### Protocol integrity

| File in the pack | How it is compared to the protocol |
|---|---|
| `definitions/analysisSpecifications.json` | SHA-256 of the whole file |
| `code/renv.lock` | SHA-256 of the whole file |
| `code/ExecuteAnalyses.R` | SHA-256 of the code **below** `DO NOT MODIFY BELOW THIS POINT`, so sites can still edit their INPUTS. Without the marker, the whole file is pinned. Any `.R` script that calls `Strategus::execute()` is accepted |

Every file in a pack is also listed with its SHA-256 in `manifest.json`, so any change after sealing is detected.

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

## Regulatory controls

Designed against ICH M14, ICH E6(R3), the FDA RWD and Part 11 Q&A guidances, the EMA computerised-systems guideline and the MHLW/PMDA database-study notices. [`docs/regulatory/requirements.md`](docs/regulatory/requirements.md) maps each requirement to its source, its implementation and its test, and lists the known limitations.

| Control | What it does |
|---|---|
| **Assurance level** | `study_config.assurance`: `standard` (everything below is a warning) or `regulatory` (the rules block, and the data-quality gate, CDM requirements and exclusion reasons are pre-specified in the protocol) |
| **Electronic signatures** | ECDSA P-256 keys generated in the browser and kept as passphrase-protected key files. Detached JWS (ES256) over `manifest.json` and `study_config.json`, showing name, role, time, time zone and meaning. Verifiable with any JOSE library |
| **Signer roster** | The coordinator enrolls each site's public key after verifying identity out of band. Only enrolled, unrevoked keys count; revocation is judged against the coordinator's receipt time |
| **Originals of modified files** | Masked results and redacted logs carry a salted commitment to the original (a plain hash would let anyone brute-force the masked values). The salts stay at the site in a retention receipt |
| **Disposition audit trail** | Every receipt, adoption, exclusion, lock and export is an append-only, hash-chained entry with who / when / old → new / why. Exclusions need a pre-specified reason code. In regulatory studies the dispositions must be locked, with an attestation that comparative results were not viewed, before the submission package is generated |

Offline there is no trusted clock, no two-factor login and no single place to keep a log; the requirements document says how each gap is mitigated and what belongs in the study's SOPs.

## StudyPack layout
```
<studyId>-pack/
├── manifest.json                 # SHA-256 of every file (+ salted commitments to masked/redacted originals)
├── manifest.jws.json             # signatures over manifest.json (when signed)
├── ro-crate-metadata.json        # RO-Crate 1.1
├── audit_report.json             # site self-audit: zero-PHI, protocol checks, DQD gate, provenance, log, time, modifications
├── protocol/study_config.json    # the protocol exactly as received (+ study_config.jws.json)
├── etl/                          # ScanReport_sanitized.xlsx, mapping_specification.json, vocabulary_version.json
├── evidence/dqd_results.json
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
```

### Demo data reference (`samples/`)

| Path | Contents |
|---|---|
| `study-repo/`, `study-repo.zip` | Strategus study repository (template layout) for Protocol Issuer |
| `protocol/` | Issued protocol: `study_config.json`, `ACEI_ANGIO_2026_protocol.zip` |
| `site/` | Clean Site Mode inputs, including DQD results and a Strategus log. Results come as both a ZIP and an expanded folder |
| `site/with_violations/` | Uncensored results (ZIP and folder) plus `executionSettings.json` with `minCellCount: 0` |
| `network/` | Four StudyPacks: Site_A and Site_B clean, Site_C tampered, Site_D with edited protected code |
| `templates/` | Source files used by `npm run samples` |

The sample `renv.lock` and result values are illustrative. They are not a tested HADES release set.

### Code layout
```
src/lib/strategus/               analysis spec, protected section of the execution script, results + RDMS audit, protocol issuance
src/lib/audit/                   small-cell / identifier audit + masking, DQD gate, execution-log audit + redaction
src/lib/integrity/               SHA-256 (Web Crypto), salted commitments
src/lib/security/                zero-network guard, key files + JWS signatures + signer roster
src/lib/provenance/              cdm_source / vocabulary / software provenance, time evidence
src/lib/studypack/               slots, readiness checks, evidence, pack builder (manifest, RO-Crate, audit_report)
src/lib/network/                 pack verification, cross-site hash checks, DQD summary, disposition audit trail
src/lib/cdisc/                   Define-XML v2.1/v2.0, Dataset-JSON v1.1/v1.0, ScanReport / mapping parsers
src/lib/export/                  audit reports (+ Markdown preview parser), regulatory submission ZIP
src/store/useStudyStore.ts       Zustand store
src/features/{site,admin}/       screens
```

## Limitations
- **CDISC validation:** Define-XML and Dataset-JSON outputs validate against the official CDISC schemas (Define-XML v2.1/v2.0 XSD, Dataset-JSON v1.1/v1.0 JSON Schema). They have **not** been run through Pinnacle 21. OMOP / Strategus tables are not SDTM/ADaM, so expect conformance-rule warnings.
- **Define-XML v2.0:** non-standard datasets cannot be flagged, so its XSD does not check Origin Type terminology.
- **Large results:** big Strategus outputs (e.g. covariate balance) are parsed on the main thread. Use the Export Hub table selection to keep submissions focused.
