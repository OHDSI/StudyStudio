# -----------------------------------------------------------------------------
# ExecuteAnalyses.R — demo study based on the OHDSI StrategusStudyRepoTemplate
# layout. Run renv::restore() once, restart R, then edit ONLY the INPUTS block.
# -----------------------------------------------------------------------------
renv::restore()

Sys.setenv("_JAVA_OPTIONS" = "-Xmx4g")
Sys.setenv("VROOM_THREADS" = 1)

##=========== START OF INPUTS ==========
options(sqlRenderTempEmulationSchema = NULL)  # Needed only on platforms without temp tables
cdmDatabaseSchema  <- "cdm"                    # Schema holding the OMOP CDM tables
workDatabaseSchema <- "scratch"                # Writable schema for study tables
cohortTableName    <- "acei_angio_2026"        # Cohort table name
resultsFolder      <- "~/acei_angio_2026/results"
workFolder         <- "~/acei_angio_2026/strategusInternals"
databaseName       <- "MY_DATABASE"            # Folder name for this site's results
minCellCount       <- 5                        # Minimum cell count for exported counts

connectionDetails <- DatabaseConnector::createConnectionDetails(
  dbms     = "postgresql",
  server   = Sys.getenv("CDM_SERVER"),
  user     = Sys.getenv("CDM_USER"),
  password = Sys.getenv("CDM_PASSWORD")
)
##=========== END OF INPUTS ==========

##################################
# DO NOT MODIFY BELOW THIS POINT
##################################
# StudyPack run record (OHDSI Study Studio, r/recordStrategusRun.R)
#
# Wrap Strategus::execute() in recordStrategusRun(). Before the run it hashes the analysis
# specification, renv.lock and the protected part of the execution script. Right after the run, in
# the same R session, it appends a record to <resultsFolder>/run_record.json: those hashes, the R and
# package versions actually loaded, and the SHA-256 of every file in the results folder. OHDSI Study
# Studio compares the record with the files that are sealed into the StudyPack.
#
# The record shows what this R session ran and wrote. It is written on the site's machine, so it
# does not prove that the site could not have produced it some other way.
#
# Paste this function below the "DO NOT MODIFY BELOW THIS POINT" marker of ExecuteAnalyses.R so it
# is pinned by the protocol like the rest of the protected section. It needs jsonlite (a Strategus
# dependency) and SHA-256 from base R >= 4.5 (tools::sha256sum) or the digest or openssl package.
recordStrategusRun <- function(code,
                               resultsFolder,
                               analysisSpecificationsFile,
                               executionScriptFile = NULL,
                               renvLockFile = "renv.lock",
                               marker = "DO NOT MODIFY BELOW THIS POINT") {
  sha256File <- function(path) {
    if (is.null(path) || is.na(path) || !file.exists(path)) return(NA_character_)
    if (exists("sha256sum", envir = asNamespace("tools"), inherits = FALSE)) {
      return(unname(tools::sha256sum(path)))
    }
    if (requireNamespace("digest", quietly = TRUE)) return(digest::digest(file = path, algo = "sha256"))
    if (requireNamespace("openssl", quietly = TRUE)) {
      con <- file(path, "rb")
      on.exit(close(con))
      return(as.character(openssl::sha256(con)))
    }
    stop("recordStrategusRun: no SHA-256 implementation (use R >= 4.5 or install 'digest')")
  }
  # Same normalisation as OHDSI Study Studio: the text after the marker line, trailing spaces/tabs
  # removed from every line, leading/trailing blank space removed, one final newline, UTF-8.
  protectedSha256 <- function(path) {
    if (is.null(path) || is.na(path) || !file.exists(path)) return(NA_character_)
    lines <- readLines(path, warn = FALSE, encoding = "UTF-8")
    i <- grep(marker, lines, fixed = TRUE)[1]
    if (is.na(i)) return(NA_character_)
    body <- if (i < length(lines)) lines[(i + 1):length(lines)] else character(0)
    text <- paste(sub("[ \t]+$", "", body), collapse = "\n")
    text <- enc2utf8(text)
    text <- sub("^[\\s\u00A0\uFEFF]+", "", text, perl = TRUE)
    text <- sub("[\\s\u00A0\uFEFF]+$", "", text, perl = TRUE)
    tmp <- tempfile()
    on.exit(unlink(tmp))
    writeBin(charToRaw(enc2utf8(paste0(text, "\n"))), tmp)
    sha256File(tmp)
  }
  detectScript <- function() {
    for (i in rev(seq_len(sys.nframe()))) {
      f <- sys.frame(i)$ofile
      if (!is.null(f)) return(f)
    }
    arg <- grep("^--file=", commandArgs(FALSE), value = TRUE)
    if (length(arg)) return(sub("^--file=", "", arg[1]))
    if (file.exists("ExecuteAnalyses.R")) return("ExecuteAnalyses.R")
    NA_character_
  }
  iso <- function(t) sub("(\\d{2})(\\d{2})$", "\\1:\\2", format(t, "%Y-%m-%dT%H:%M:%S%z"))
  now <- function() iso(Sys.time())
  input <- function(path, ...) list(file = if (is.null(path) || is.na(path)) NA_character_ else basename(path), sha256 = sha256File(path), ...)

  # The file system's own clock at the start (a network share can differ from this machine's clock),
  # read from a probe file, so modification times are compared on one clock.
  fileSystemNow <- function() {
    tryCatch({
      if (!dir.exists(resultsFolder)) dir.create(resultsFolder, recursive = TRUE)
      probe <- tempfile(".run_record_probe", tmpdir = resultsFolder)
      writeLines("", probe)
      on.exit(unlink(probe))
      iso(file.mtime(probe))
    }, error = function(e) NA_character_)
  }
  writeRecord <- function(startedAt, finishedAt, status, errorClass) {
    if (!dir.exists(resultsFolder)) dir.create(resultsFolder, recursive = TRUE)
    recordFile <- file.path(resultsFolder, "run_record.json")
    paths <- sort(list.files(resultsFolder, recursive = TRUE, all.files = FALSE))
    paths <- paths[!grepl("^run_record(\\.invalid-[0-9T-]+)?\\.json$", paths)]
    # modifiedAt shows whether a file was written during this run or left by an earlier one.
    results <- lapply(paths, function(p) {
      full <- file.path(resultsFolder, p)
      list(path = gsub("\\\\", "/", p), sha256 = sha256File(full), sizeBytes = unname(file.size(full)),
           modifiedAt = iso(file.mtime(full)))
    })
    pkgs <- sort(loadedNamespaces())
    run <- list(
      startedAt = startedAt,
      startedAtFileSystem = startedAtFileSystem,
      finishedAt = finishedAt,
      status = status,
      errorClass = errorClass,
      r = paste(R.version$major, R.version$minor, sep = "."),
      platform = R.version$platform,
      packages = as.list(stats::setNames(vapply(pkgs, function(p) as.character(utils::packageVersion(p)), ""), pkgs)),
      inputs = inputs,
      results = results
    )
    record <- if (file.exists(recordFile)) tryCatch(jsonlite::fromJSON(recordFile, simplifyVector = FALSE), error = function(e) NULL)
    if (file.exists(recordFile) && (is.null(record) || !identical(record$format, "studypack-run-record/1"))) {
      # Keep an unreadable or foreign file aside instead of overwriting it, and start a new record.
      aside <- file.path(resultsFolder, paste0("run_record.invalid-", format(Sys.time(), "%Y%m%dT%H%M%S"), ".json"))
      file.rename(recordFile, aside)
      warning("recordStrategusRun: existing run_record.json could not be read; moved to ", basename(aside), call. = FALSE)
      record <- NULL
    }
    if (is.null(record)) record <- list(format = "studypack-run-record/1", runs = list())
    record$runs <- c(record$runs, list(run))
    jsonlite::write_json(record, recordFile, auto_unbox = TRUE, pretty = TRUE, na = "null", null = "null", digits = NA)
    message("Run record written to ", recordFile)
  }

  if (is.null(executionScriptFile)) executionScriptFile <- detectScript()
  # Inputs are hashed before `code` (a lazily evaluated argument) runs, i.e. as the run reads them.
  inputs <- list(
    analysisSpecifications = input(analysisSpecificationsFile),
    executionScript = input(executionScriptFile, protectedSha256 = protectedSha256(executionScriptFile)),
    renvLock = input(renvLockFile)
  )
  startedAtFileSystem <- fileSystemNow()
  startedAt <- now()
  status <- "completed"
  errorClass <- NA_character_
  failure <- NULL
  value <- tryCatch(code, error = function(e) {
    status <<- "failed"
    # Only the condition class: error messages can contain hosts, user names or paths.
    errorClass <<- class(e)[1]
    failure <<- e
    NULL
  })
  finishedAt <- now()

  # A problem writing the record is reported as a warning so it never hides the run's own error.
  tryCatch(writeRecord(startedAt, finishedAt, status, errorClass), error = function(e) {
    warning("recordStrategusRun: run_record.json not written (a regulatory StudyPack cannot be sealed without it): ",
            conditionMessage(e), call. = FALSE)
  })
  if (!is.null(failure)) stop(failure)
  invisible(value)
}

config <- config::get()

resultsFolder <- file.path(resultsFolder, databaseName)
workFolder <- file.path(workFolder, databaseName)

analysisSpecifications <- ParallelLogger::loadSettingsFromJson(
  fileName = file.path(config$projectRootFolder, "inst", config$studySpecificationFileName)
)

executionSettings <- Strategus::createCdmExecutionSettings(
  workDatabaseSchema = workDatabaseSchema,
  cdmDatabaseSchema = cdmDatabaseSchema,
  cohortTableNames = CohortGenerator::getCohortTableNames(cohortTable = cohortTableName),
  workFolder = workFolder,
  resultsFolder = resultsFolder,
  minCellCount = minCellCount
)

if (!dir.exists(resultsFolder)) dir.create(resultsFolder, recursive = TRUE)
if (!dir.exists(workFolder)) dir.create(workFolder, recursive = TRUE)

ParallelLogger::saveSettingsToJson(
  object = executionSettings,
  fileName = file.path(resultsFolder, "executionSettings.json")
)

# Writes <resultsFolder>/run_record.json right after the run (see recordStrategusRun above).
recordStrategusRun(
  Strategus::execute(
    analysisSpecifications = analysisSpecifications,
    executionSettings = executionSettings,
    connectionDetails = connectionDetails
  ),
  resultsFolder = resultsFolder,
  analysisSpecificationsFile = file.path(config$projectRootFolder, "inst", config$studySpecificationFileName),
  executionScriptFile = file.path(config$projectRootFolder, "ExecuteAnalyses.R"),
  renvLockFile = file.path(config$projectRootFolder, "renv.lock")
)
