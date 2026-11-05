# OHDSI Study Studio

A browser-only workspace for running OHDSI network studies. It sits between the study coordinator and participating hospitals. Use it to:

1. **Distribute** a Strategus study with its code and settings pinned by SHA-256.
2. **Check** each site's results for small cells before anything leaves the hospital.
3. **Package** the results into a tamper-evident file (a *StudyPack*).
4. **Verify** all the packs centrally and export CDISC Define-XML / Dataset-JSON for regulators.

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

### 2. Site: build a StudyPack
1. **Site Mode**, then enter a **Site ID** (e.g. `Site_A`).
2. **Step 1:** drop `samples/protocol/ACEI_ANGIO_2026_protocol.zip`. The spec, `ExecuteAnalyses.R` and `renv.lock` are filled in for you.
3. **Step 2:** drop the files in `samples/site/`. They are assigned to slots by file name. For the Strategus results, use either:
   - `strategus_results_Site_A.zip` (the drop zone), or
   - the `strategus_results_Site_A/` folder (**Choose results folder…**).
4. **Step 3:** **Download StudyPack**.

To see the safety lock, use `samples/site/with_violations/` instead of the matching files in `samples/site/`: the results ZIP or folder, plus its `executionSettings.json`. Then:
- The audit finds small cells and blocks the download.
- A warning says the results were exported with a lower `minCellCount` (0) than the protocol requires (5).
- **One-click auto-masking** fixes the cells (`-5` by default), and the download unlocks.

### 3. Coordinator: verify and export
1. **Admin Mode → Multi-Site Aggregator**.
2. Drop the four packs in `samples/network/`. Optionally drop `samples/protocol/study_config.json` as well; without it, the majority hash is used as the reference.
3. Expected result:

   | Pack | Result | Why |
   |---|---|---|
   | Site_A | ✅ adopt | clean |
   | Site_B | ✅ adopt | clean (its INPUTS block differs, which is allowed) |
   | Site_C | ❌ exclude | a result file was changed after sealing |
   | Site_D | ❌ exclude | code below the protected marker was edited |

4. **Export Hub**:
   - **Audit report:** live **Preview**, **Markdown source**, Markdown download, or **PDF (print)**.
   - **Submission package:** choose the Define-XML / Dataset-JSON versions and the result tables, then generate the ZIP.

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
| `site/` | Clean Site Mode inputs. Results come as both a ZIP and an expanded folder |
| `site/with_violations/` | Uncensored results (ZIP and folder) plus `executionSettings.json` with `minCellCount: 0` |
| `network/` | Four StudyPacks: Site_A and Site_B clean, Site_C tampered, Site_D with edited protected code |
| `templates/` | Source files used by `npm run samples` |

The sample `renv.lock` and result values are illustrative. They are not a tested HADES release set.

### Code layout
```
src/lib/strategus/               analysis spec, protected section of the execution script, results + RDMS audit, protocol issuance
src/lib/audit/cellAuditor.ts     small-cell / identifier audit + masking (CSV, XLSX)
src/lib/integrity/hasher.ts      SHA-256 (Web Crypto)
src/lib/studypack/               slots, readiness checks, pack builder (manifest, RO-Crate, audit_report)
src/lib/network/                 pack verification, cross-site hash checks, DQD summary
src/lib/cdisc/                   Define-XML v2.1/v2.0, Dataset-JSON v1.1/v1.0, ScanReport / mapping parsers
src/lib/export/                  audit reports (+ Markdown preview parser), regulatory submission ZIP
src/store/useStudyStore.ts       Zustand store
src/features/{site,admin}/       screens
```

## Limitations
- **CDISC validation:** Define-XML and Dataset-JSON outputs validate against the official CDISC schemas (Define-XML v2.1/v2.0 XSD, Dataset-JSON v1.1/v1.0 JSON Schema). They have **not** been run through Pinnacle 21. OMOP / Strategus tables are not SDTM/ADaM, so expect conformance-rule warnings.
- **Define-XML v2.0:** non-standard datasets cannot be flagged, so its XSD does not check Origin Type terminology.
- **Large results:** big Strategus outputs (e.g. covariate balance) are parsed on the main thread. Use the Export Hub table selection to keep submissions focused.
