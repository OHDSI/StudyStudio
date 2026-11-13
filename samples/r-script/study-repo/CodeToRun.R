# Synthetic demo of an "R script" study for OHDSI Study Studio: which domains does FACT_RELATIONSHIP link?
# Modelled on the question raised in https://forums.ohdsi.org/t/26074 (fact_relationship revisited in 2026).
# Output: one CSV with the share (%) of fact_relationship rows per domain pair; no counts are written.

# --- Set database and CDM schema here (edit the values in this section) ---

myDbms <- "postgresql"
cdmDatabaseSchema <- "cdm"

connectionDetails <- DatabaseConnector::createConnectionDetails(
  dbms = myDbms,
  server = keyring::key_get("server"),
  user = keyring::key_get("user"),
  password = keyring::key_get("password")
)

# --- script starts here ----

conn <- DatabaseConnector::connect(connectionDetails)

sql <- "
SELECT
  fr.domain_concept_id_1,
  c1.concept_name AS domain_concept_name_1,
  fr.domain_concept_id_2,
  c2.concept_name AS domain_concept_name_2,
  COUNT(*) AS cnt
FROM @cdm_database_schema.fact_relationship fr
INNER JOIN @cdm_database_schema.concept c1 ON fr.domain_concept_id_1 = c1.concept_id
INNER JOIN @cdm_database_schema.concept c2 ON fr.domain_concept_id_2 = c2.concept_id
GROUP BY fr.domain_concept_id_1, c1.concept_name, fr.domain_concept_id_2, c2.concept_name;
"
pairs <- DatabaseConnector::renderTranslateQuerySql(
  connection = conn,
  sql = sql,
  cdm_database_schema = cdmDatabaseSchema,
  snakeCaseToCamelCase = TRUE
)
DatabaseConnector::disconnect(conn)

total <- sum(as.numeric(pairs$cnt))
pairs$percentage <- if (total > 0) round(100 * as.numeric(pairs$cnt) / total, digits = 2) else numeric(nrow(pairs))

utils::write.csv(
  pairs[, c("domainConceptId1", "domainConceptName1", "domainConceptId2", "domainConceptName2", "percentage")],
  file = "fact_relationships-aggregated-and-relative-data.csv",
  row.names = FALSE
)
