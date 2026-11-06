# Run with: Rscript r/tests/test-recordStrategusRun.R
# Needs jsonlite; SHA-256 from R >= 4.5, digest or openssl. No database or Strategus required:
# the "run" below writes result files the way Strategus::execute() would.
args <- commandArgs(FALSE)
here <- dirname(normalizePath(sub("^--file=", "", grep("^--file=", args, value = TRUE)[1])))
source(file.path(here, "..", "recordStrategusRun.R"))

check <- function(ok, what) {
  if (!isTRUE(ok)) stop("FAILED: ", what, call. = FALSE)
  cat("ok -", what, "\n")
}

dir <- tempfile("studypack-run-record-")
dir.create(dir)
spec <- file.path(dir, "analysisSpecifications.json")
writeLines('{"moduleSpecifications":[]}', spec)
lock <- file.path(dir, "renv.lock")
writeLines('{"R":{"Version":"4.5.0"},"Packages":{}}', lock)
script <- file.path(dir, "ExecuteAnalyses.R")
writeLines(c("minCellCount <- 5   ", "# DO NOT MODIFY BELOW THIS POINT", "", "x <- 1   ", "\ty <- 2\t", "", ""), script)
results <- file.path(dir, "results", "Site_A")

recordStrategusRun(
  {
    dir.create(file.path(results, "CohortMethodModule"), recursive = TRUE)
    writeLines(c("a,b", "1,2"), file.path(results, "CohortMethodModule", "cm_result.csv"))
    writeLines("{}", file.path(results, "executionSettings.json"))
  },
  resultsFolder = results,
  analysisSpecificationsFile = spec,
  executionScriptFile = script,
  renvLockFile = lock
)

rec <- jsonlite::fromJSON(file.path(results, "run_record.json"), simplifyVector = FALSE)
check(identical(rec$format, "studypack-run-record/1"), "format")
check(length(rec$runs) == 1, "one run")
run <- rec$runs[[1]]
check(identical(run$status, "completed"), "status completed")
check(is.null(run$errorClass), "no error class")
check(grepl("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}[+-]\\d{2}:\\d{2}$", run$startedAt), "ISO time with offset")
check(identical(run$inputs$analysisSpecifications$sha256, unname(tools::sha256sum(spec))), "spec hash")
check(identical(run$inputs$renvLock$file, "renv.lock"), "renv.lock file name only, no path")
check(identical(sort(vapply(run$results, `[[`, "", "path")), c("CohortMethodModule/cm_result.csv", "executionSettings.json")), "results listed relative to the results folder")
check(!is.null(run$packages$stats) && !is.null(run$packages$utils), "loaded packages recorded")
check(grepl("[+-]\\d{2}:\\d{2}$", run$startedAtFileSystem) && length(list.files(results, all.files = TRUE, pattern = "probe")) == 0, "file-system start time recorded, probe removed")
check(all(vapply(run$results, function(f) grepl("[+-]\\d{2}:\\d{2}$", f$modifiedAt), TRUE)), "modification time recorded per file")
# Protected section: "x <- 1\n\ty <- 2\n" after normalisation (must match OHDSI Study Studio).
expected <- {
  tmp <- tempfile()
  writeBin(charToRaw("x <- 1\n\ty <- 2\n"), tmp)
  unname(tools::sha256sum(tmp))
}
check(identical(run$inputs$executionScript$protectedSha256, expected), "protected section hash")

# A failed run is recorded (without the error message) and the error is re-raised.
err <- tryCatch(
  recordStrategusRun(stop("connection to db01 failed for user omop"), resultsFolder = results, analysisSpecificationsFile = spec, executionScriptFile = script, renvLockFile = lock),
  error = function(e) conditionMessage(e)
)
check(grepl("db01", err), "error re-raised")
rec <- jsonlite::fromJSON(file.path(results, "run_record.json"), simplifyVector = FALSE)
check(length(rec$runs) == 2, "second run appended")
check(identical(rec$runs[[2]]$status, "failed"), "failed run recorded")
check(!grepl("db01", paste(readLines(file.path(results, "run_record.json")), collapse = "\n")), "error message not written")

# Inputs are hashed before the run: a run that rewrites the specification still records what it read.
before <- unname(tools::sha256sum(spec))
recordStrategusRun(writeLines('{"changed":true}', spec), resultsFolder = results, analysisSpecificationsFile = spec, executionScriptFile = script, renvLockFile = lock)
rec <- jsonlite::fromJSON(file.path(results, "run_record.json"), simplifyVector = FALSE)
check(identical(rec$runs[[3]]$inputs$analysisSpecifications$sha256, before), "inputs hashed before the run")

# A record that cannot be written gives a warning and never hides the run's own error.
blocked <- file.path(dir, "not-a-folder")
writeLines("x", blocked)
warned <- FALSE
err <- withCallingHandlers(
  tryCatch(
    recordStrategusRun(stop("module failed"), resultsFolder = file.path(blocked, "results"), analysisSpecificationsFile = spec, executionScriptFile = script, renvLockFile = lock),
    error = function(e) conditionMessage(e)
  ),
  warning = function(w) {
    if (grepl("run_record.json not written", conditionMessage(w))) warned <<- TRUE
    invokeRestart("muffleWarning")
  }
)
check(identical(err, "module failed") && warned, "write failure warns, run error kept")

# Strategus 1.x returns module statuses instead of stopping: a failed or blocked module fails the run.
strategusLike <- function(...) list(...)
recordStrategusRun(
  strategusLike(
    list(moduleName = "CohortGeneratorModule", status = "SKIPPED", errorMessage = "Matching completed execution record found", executionTime = "SKIPPED"),
    list(moduleName = "CohortMethodModule", status = "SUCCESS", errorMessage = NULL, executionTime = "1 mins")
  ),
  resultsFolder = results, analysisSpecificationsFile = spec, executionScriptFile = script, renvLockFile = lock
)
moduleWarning <- NULL
withCallingHandlers(recordStrategusRun(
  strategusLike(
    list(moduleName = "CohortGeneratorModule", status = "FAILED", errorMessage = "no package called 'CirceR' on db01", executionTime = "0 secs"),
    list(moduleName = "CohortMethodModule", status = "SKIPPED", errorMessage = "Cohort generation failed", executionTime = "SKIPPED")
  ),
  resultsFolder = results, analysisSpecificationsFile = spec, executionScriptFile = script, renvLockFile = lock
), warning = function(w) { moduleWarning <<- conditionMessage(w); invokeRestart("muffleWarning") })
check(grepl("CohortGeneratorModule FAILED", moduleWarning), "warns when modules did not complete")
rec <- jsonlite::fromJSON(file.path(results, "run_record.json"), simplifyVector = FALSE)
ok <- rec$runs[[length(rec$runs) - 1]]
bad <- rec$runs[[length(rec$runs)]]
check(identical(ok$status, "completed") && isTRUE(ok$modules[[1]]$skippedAsCompleted), "modules skipped as completed keep the run completed")
check(identical(bad$status, "failed") && identical(bad$errorClass, "StrategusModuleFailure") && identical(bad$modules[[2]]$status, "SKIPPED"), "a failed module fails the run")
check(!grepl("db01", paste(readLines(file.path(results, "run_record.json")), collapse = "\n")), "module error messages not written")

# An unreadable record is moved aside and a new one is started.
writeLines("{ not json", file.path(results, "run_record.json"))
suppressWarnings(recordStrategusRun(NULL, resultsFolder = results, analysisSpecificationsFile = spec, executionScriptFile = script, renvLockFile = lock))
rec <- jsonlite::fromJSON(file.path(results, "run_record.json"), simplifyVector = FALSE)
aside <- list.files(results, pattern = "^run_record\\.invalid-")
check(length(rec$runs) == 1 && length(aside) == 1, "unreadable record moved aside, new record started")
check(!any(grepl("run_record", vapply(rec$runs[[1]]$results, `[[`, "", "path"))), "record files not listed as results")

cat("Results folder kept for inspection:", results, "\n")
