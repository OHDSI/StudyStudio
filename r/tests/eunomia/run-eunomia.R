# End-to-end check of recordStrategusRun() with a real Strategus run on Eunomia (GiBleed).
#
#   Rscript r/tests/eunomia/run-eunomia.R <output folder>
#   STUDYSTUDIO_EUNOMIA=<output folder> npx vitest run src/lib/strategus/runRecord.eunomia.test.ts
#
# Builds a study folder in the StrategusStudyRepoTemplate shape (analysis specification, renv.lock,
# ExecuteAnalyses.R with the protected marker and recordStrategusRun() below it), then runs the script
# twice with Rscript: a full run of CohortGeneratorModule and CohortMethodModule, and a re-run with
# skipCompletedTasks = TRUE. Finally Strategus::zipResults() is called. Needs Strategus, CohortMethod,
# FeatureExtraction, Eunomia and RSQLite; EUNOMIA_DATA_FOLDER must point to a writable folder.
args <- commandArgs(TRUE)
if (length(args) != 1) stop("usage: Rscript r/tests/eunomia/run-eunomia.R <output folder>")
out <- normalizePath(args[1], mustWork = FALSE)
unlink(out, recursive = TRUE)
study <- file.path(out, "study")
dir.create(file.path(study, "inst"), recursive = TRUE)

# Analysis specification: the one Strategus tests on Eunomia.
spec <- file.path(study, "inst", "analysisSpecifications.json")
file.copy(system.file("testdata", "cdmModulesAnalysisSpecifications.json", package = "Strategus"), spec)

# renv.lock with the versions installed here, so the record's loaded versions must agree with it.
hades <- c("Strategus", "CohortGenerator", "CohortMethod", "Cyclops", "FeatureExtraction", "DatabaseConnector",
           "SqlRender", "ParallelLogger", "ResultModelManager", "Andromeda", "EmpiricalCalibration")
hades <- hades[vapply(hades, function(p) nzchar(system.file(package = p)), TRUE)]
lock <- list(
  R = list(Version = paste(R.version$major, R.version$minor, sep = ".")),
  Packages = stats::setNames(lapply(hades, function(p) list(Package = p, Version = as.character(utils::packageVersion(p)))), hades)
)
jsonlite::write_json(lock, file.path(study, "renv.lock"), auto_unbox = TRUE, pretty = TRUE)

# ExecuteAnalyses.R: INPUTS, the marker, the function, then the template's execution code.
fn <- readLines("r/recordStrategusRun.R")
script <- c(
  "##=========== START OF INPUTS ==========",
  "studyFolder <- Sys.getenv(\"STUDY_FOLDER\")",
  "resultsFolder <- file.path(studyFolder, \"..\", \"results\")",
  "workFolder <- file.path(studyFolder, \"..\", \"work\")",
  "skipCompletedTasks <- identical(Sys.getenv(\"SKIP_COMPLETED\"), \"TRUE\")",
  "connectionDetails <- Eunomia::getEunomiaConnectionDetails(databaseFile = file.path(studyFolder, \"..\", \"eunomia.sqlite\"))",
  "##=========== END OF INPUTS ==========",
  "",
  "##################################",
  "# DO NOT MODIFY BELOW THIS POINT",
  "##################################",
  fn,
  "",
  "resultsFolder <- normalizePath(resultsFolder, mustWork = FALSE)",
  "analysisSpecifications <- ParallelLogger::loadSettingsFromJson(file.path(studyFolder, \"inst\", \"analysisSpecifications.json\"))",
  "executionSettings <- Strategus::createCdmExecutionSettings(",
  "  workDatabaseSchema = \"main\",",
  "  cdmDatabaseSchema = \"main\",",
  "  cohortTableNames = CohortGenerator::getCohortTableNames(cohortTable = \"studystudio\"),",
  "  workFolder = workFolder,",
  "  resultsFolder = resultsFolder,",
  "  minCellCount = 5,",
  "  modulesToExecute = c(\"CohortGeneratorModule\", \"CohortMethodModule\"),",
  "  skipCompletedTasks = skipCompletedTasks",
  ")",
  "if (!dir.exists(resultsFolder)) dir.create(resultsFolder, recursive = TRUE)",
  "if (!dir.exists(workFolder)) dir.create(workFolder, recursive = TRUE)",
  "ParallelLogger::saveSettingsToJson(object = executionSettings, fileName = file.path(resultsFolder, \"executionSettings.json\"))",
  "recordStrategusRun(",
  "  Strategus::execute(analysisSpecifications = analysisSpecifications, executionSettings = executionSettings, connectionDetails = connectionDetails),",
  "  resultsFolder = resultsFolder,",
  "  analysisSpecificationsFile = file.path(studyFolder, \"inst\", \"analysisSpecifications.json\"),",
  "  executionScriptFile = file.path(studyFolder, \"ExecuteAnalyses.R\"),",
  "  renvLockFile = file.path(studyFolder, \"renv.lock\")",
  ")"
)
writeLines(script, file.path(study, "ExecuteAnalyses.R"))

run <- function(skip) {
  started <- Sys.time()
  status <- system2("Rscript", file.path(study, "ExecuteAnalyses.R"), env = c(paste0("STUDY_FOLDER=", study), paste0("SKIP_COMPLETED=", if (skip) "TRUE" else "FALSE")))
  message(sprintf("Run (skipCompletedTasks = %s) exited with %s after %.1f min", skip, status, as.numeric(difftime(Sys.time(), started, units = "mins"))))
  if (status != 0) stop("ExecuteAnalyses.R failed")
}
run(skip = FALSE)
Sys.sleep(3) # so a re-run that rewrote a file is distinguishable from one that skipped it
run(skip = TRUE)

results <- file.path(out, "results")
Strategus::zipResults(resultsFolder = results, zipFile = file.path(out, "results.zip"))

record <- jsonlite::fromJSON(file.path(results, "run_record.json"), simplifyVector = FALSE)
last <- record$runs[[length(record$runs)]]
diagnostics <- list(
  strategus = as.character(utils::packageVersion("Strategus")),
  runs = length(record$runs),
  loadedHades = names(last$packages)[names(last$packages) %in% hades],
  zipEntries = utils::unzip(file.path(out, "results.zip"), list = TRUE)$Name,
  csvRewrittenByRerun = sum(vapply(last$results, function(f) grepl("\\.csv$", f$path) && f$modifiedAt >= last$startedAtFileSystem, TRUE)),
  csvTotal = sum(vapply(last$results, function(f) grepl("\\.csv$", f$path), TRUE))
)
jsonlite::write_json(diagnostics, file.path(out, "diagnostics.json"), auto_unbox = TRUE, pretty = TRUE)
cat(readLines(file.path(out, "diagnostics.json")), sep = "\n")
