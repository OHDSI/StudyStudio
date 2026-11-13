# Demo data

Everything here is synthetic. `npm run samples` regenerates it (`scripts/make-samples.ts`); the demo keys in
`regulatory/keys/` are kept so that the signers stay the same.

## What goes where

| Screen | Drop |
|---|---|
| **Admin → Protocol Issuer** | `study-repo.zip` (or the files in `study-repo/`) |
| **Site Mode → Step 1** | `standard/protocol/ACEI_ANGIO_2026_protocol.zip` (or `regulatory/protocol/…`) |
| **Site Mode → Step 2** | one whole folder from `site-inputs/`: `clean/`, `small-cells/` or `dqd-failure/` |
| **Admin → Multi-Site Aggregator** | standard: `standard/protocol/study_config.json`, then `standard/packs/` |
| | regulatory: `regulatory/protocol/ACEI_ANGIO_2026_protocol.zip`, `regulatory/roster/`, then `regulatory/packs/` |
| | R script study: `r-script/protocol/study_config.json`, then `r-script/packs/` |

For the R script study, Protocol Issuer takes `r-script/study-repo/CodeToRun.R`, and Site Mode takes
`r-script/protocol/FACT_REL_2026_protocol.zip` then the CSV in `r-script/site-inputs/`.

## Folders

```
samples/
├── study-repo/, study-repo.zip   Strategus study repository (StrategusStudyRepoTemplate layout)
├── site-inputs/                  Site Mode Step 2 — each scenario folder is a complete set: drop it as a whole
│   ├── clean/                    passes
│   ├── small-cells/              uncensored results, minCellCount 0: download blocked until masked
│   ├── dqd-failure/              structural DQD failure: a regulatory pack cannot be sealed
│   └── expanded/                 the clean and small-cells results as folders, for "Choose results folder…"
├── standard/
│   ├── protocol/                 issued protocol (ZIP + study_config.json)
│   └── packs/                    Site_A, Site_B clean · Site_C tampered · Site_D edited protected code
├── regulatory/
│   ├── protocol/                 signed protocol (ZIP + study_config.json + study_config.jws.json)
│   ├── roster/                   signer roster signed by the protocol issuer
│   ├── packs/                    Site_A, Site_B adopted · Site_C key not enrolled · Site_D key revoked
│   └── keys/                     demo keys, passphrase demo-passphrase-not-secret (never reuse them)
├── r-script/                     R script study (no Strategus): one CodeToRun.R, one aggregated CSV
│   ├── study-repo/CodeToRun.R    the study script (input of the generator, not regenerated)
│   ├── protocol/                 issued protocol, pinned below "# --- script starts here ----"
│   ├── site-inputs/              the CSV a site's run wrote (percentages only)
│   └── packs/                    Site_A, Site_B clean · Site_C edited query · Site_D tampered
└── _source/                      inputs of npm run samples (ATLAS cohorts, templates, site ETL files)
```

Each `site-inputs/<scenario>/` holds the same seven files: the results ZIP, `executionSettings.json`,
`dqd_results.json`, `strategus-log.txt`, `ScanReport_sanitized.xlsx`, `mapping_specification.json` and
`vocabulary_version.json`. The run record is inside the results ZIP.

To sign a regulatory pack, unlock `regulatory/keys/site_a_operator.key.json`. The coordinator verifies signatures
against the roster and needs no key for that.
