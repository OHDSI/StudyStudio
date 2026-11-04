# Study Studio

OHDSI Study & Regulatory Pack GUI Workspace. It's a fully client-side single-page app: no server, no Electron, **zero network transmission**.

`npm run build` produces one self-contained `dist/index.html`. You can copy it into a hospital's closed network and open it directly from `file://`.

## Position in the OHDSI stack

Study Studio does **not** write analysis code. Studies are designed and executed with OHDSI **Strategus** (HADES), the framework used by current OHDSI network studies. The [StrategusStudyRepoTemplate](https://github.com/ohdsi-studies/StrategusStudyRepoTemplate) layout is recognised but not required. Study Studio is the layer around Strategus that:

- **pins** the coordinator's analysis specification, execution script and `renv.lock` with SHA-256 and distributes them to sites;
- **audits** each site's Strategus results in the browser (0 < n < minCellCount, direct identifiers) and **blocks export** until they are clean;
- **seals** everything into a tamper-evident StudyPack. This is an offline alternative to SFTP upload for sites that cannot reach the internet;
- **cross-checks** the packs from all sites, and exports CDISC **Define-XML v2.1/v2.0** and **Dataset-JSON v1.1/v1.0** plus an audit report.

## Zero-Transmission guarantees
- The production build injects a CSP with `connect-src 'none'`, `form-action 'none'` and `frame-src 'none'`. The browser itself refuses fetch, XHR, WebSocket and beacons.
- A runtime guard (`src/lib/security/networkGuard.ts`) also disables `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon`.
- All processing runs in memory: hashing with the Web Crypto API, ZIPs with JSZip, Excel with SheetJS, CSV with PapaParse.

## Workflow

| Who | Where | What |
|---|---|---|
| Study designer | R, StrategusStudyRepoTemplate (`scriptsForStudyDesigner/`) or own layout | Builds the analysis specification JSON: cohorts, negative controls, CohortMethod / SCCS / … modules |
| Coordinator | 🌐 Admin → **Protocol Issuer** | Drops the study repository (GitHub ZIP or files), reviews the spec summary, issues `<studyId>_protocol.zip` + `study_config.json` |
| Site | R | `renv::restore()`, fills in the INPUTS block of the execution script, runs `Strategus::execute()` |
| Site | 🏥 Site Mode | Imports the protocol ZIP, drops DQD / ETL artifacts, the Strategus results folder or ZIP and `executionSettings.json`. The audit runs, auto-masking applies (`-5` by default), and `[siteId]_[studyId].studypack.zip` is produced |
| Coordinator | 🌐 Admin → **Aggregator** / **Export Hub** | Verifies the packs, adopts or excludes sites, views the audit report, exports Define-XML / Dataset-JSON |

### What is pinned and compared

| StudyPack path | Comparison |
|---|---|
| `definitions/analysisSpecifications.json` | whole-file SHA-256 |
| `code/renv.lock` | whole-file SHA-256 |
| `code/ExecuteAnalyses.R` | SHA-256 of the code **below** `DO NOT MODIFY BELOW THIS POINT` when that marker is present, so sites can edit their INPUTS. Otherwise the whole file is pinned. Any `.R` script that calls `Strategus::execute()` is accepted |

### Small-cell audit of Strategus results
- Results are read as `<Module>/<table>.csv` from the folder written by `Strategus::execute()` or the ZIP from `Strategus::zipResults()`.
- Each module's `resultsDataModelSpecification.csv` names the integer columns flagged `min_cell_count = Yes`, and exactly those are checked. Tables without a model fall back to column-name heuristics.
- Censored values follow the HADES convention `-minCellCount`, which keeps the columns numeric for the OHDSI results database. One-click masking writes `-5` by default; `<5` and `NA` are optional.

## StudyPack layout
```
<studyId>-pack/
├── manifest.json                 # SHA-256 of every file
├── ro-crate-metadata.json        # RO-Crate 1.1
├── audit_report.json             # site self-audit (zero-PHI, protocol checks)
├── etl/                          # ScanReport_sanitized.xlsx, mapping_specification.json, vocabulary_version.json
├── evidence/dqd_results.json
├── definitions/analysisSpecifications.json
├── code/ExecuteAnalyses.R, renv.lock, executionSettings.json
└── results/<ModuleName>/*.csv    # Strategus results (+ resultsDataModelSpecification.csv per module)
```

## Development
```bash
npm install
npm run dev        # dev server (no CSP, so HMR works)
npm test           # vitest
npm run build      # single-file dist/index.html
npm run samples    # regenerate demo data under samples/
```

### Demo data (`samples/`, synthetic)
- `study-repo/`, `study-repo.zip`: a Strategus study repository in the template layout. Drop it into Protocol Issuer.
- `protocol/`: the issued protocol (`study_config.json`, `ACEI_ANGIO_2026_protocol.zip`).
- `site/`: Site Mode inputs. `strategus_results_Site_A_with_violations.zip` was exported without censoring and triggers the lock.
- `network/`: four packs. Site_A and Site_B are clean; their INPUTS blocks differ but they still match the protocol. Site_C was **tampered** with after sealing. Site_D **edited code below the protected marker**.

The sample `renv.lock` and result values are illustrative. They are not a tested HADES release set.

## Layout
```
src/lib/strategus/               analysis specification, execution-script protected section, results + RDMS audit, protocol issuance
src/lib/audit/cellAuditor.ts     small-cell / identifier audit + remediation (CSV, XLSX)
src/lib/integrity/hasher.ts      SHA-256 (Web Crypto)
src/lib/studypack/               slots, readiness guardrail, pack builder (manifest, RO-Crate, audit_report)
src/lib/network/                 multi-pack verification, cross-site hash checks, DQD summary
src/lib/cdisc/                   Define-XML v2.1/v2.0, Dataset-JSON v1.1/v1.0, ScanReport / mapping parsers
src/lib/export/                  audit reports + regulatory submission ZIP
src/store/useStudyStore.ts       Zustand store
src/features/{site,admin}/       screens
```

## Notes / limitations
- Define-XML and Dataset-JSON outputs validate against the official CDISC schemas (Define-XML v2.1/v2.0 XSD, Dataset-JSON v1.1/v1.0 JSON Schema). They have **not** been run through Pinnacle 21. OMOP / Strategus tables are not SDTM/ADaM, so expect conformance-rule warnings.
- Define-XML v2.0 cannot flag non-standard datasets, so its XSD does not check Origin Type terminology.
- Large Strategus outputs (e.g. covariate balance) are parsed in the main thread. Use the Export Hub table selection to keep submissions focused.
