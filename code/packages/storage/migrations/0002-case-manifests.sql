-- S06 owns immutable run manifests. This additive extension resolves B0/G01.
-- The frozen 0001.sql / engineering 0.2.0 DTOs remain unchanged.
CREATE TABLE case_run_manifests(
  run_id TEXT PRIMARY KEY REFERENCES analysis_runs(id),
  case_id TEXT NOT NULL REFERENCES cases(id),
  metadata_hash TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Exact per-page references make cursor retries return that page, rather than the whole query.
CREATE TABLE case_query_page_refs(
  page_id TEXT PRIMARY KEY REFERENCES query_pages(page_id),
  refs_json TEXT NOT NULL
);
