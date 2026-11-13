# Writes a run record with this R installation over a copy of the sample results, so that
# src/lib/strategus/runRecord.r.test.ts can check it with the TypeScript implementation (R and the
# browser must hash the protected section and the files the same way).
#
#   Rscript r/tests/cross-check.R <output folder>
#   STUDYSTUDIO_R_RECORD=<output folder> npx vitest run src/lib/strategus/runRecord.r.test.ts
#
# Run from the repository root. Strategus is not needed: the wrapped code copies the sample results
# into the results folder the way Strategus::execute() would write them.
args <- commandArgs(TRUE)
if (length(args) != 1) stop("usage: Rscript r/tests/cross-check.R <output folder>")
source("r/recordStrategusRun.R")

out <- args[1]
unlink(out, recursive = TRUE)
dir.create(out, recursive = TRUE)
sample <- "samples/site-inputs/expanded/strategus_results_Site_A"
files <- setdiff(list.files(sample, recursive = TRUE), "run_record.json")

recordStrategusRun(
  for (f in files) {
    dir.create(dirname(file.path(out, f)), recursive = TRUE, showWarnings = FALSE)
    file.copy(file.path(sample, f), file.path(out, f))
  },
  resultsFolder = out,
  analysisSpecificationsFile = "samples/study-repo/inst/analysisSpecifications.json",
  executionScriptFile = "samples/study-repo/ExecuteAnalyses.R",
  renvLockFile = "samples/study-repo/renv.lock"
)
