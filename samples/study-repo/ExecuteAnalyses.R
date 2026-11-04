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

Strategus::execute(
  analysisSpecifications = analysisSpecifications,
  executionSettings = executionSettings,
  connectionDetails = connectionDetails
)
