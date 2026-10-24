-- Preserve the mapping actually used at preparation; later connection edits must not rewrite a run manifest.
-- Legacy runs have no provable mapping version and therefore retain explicit unknown.
ALTER TABLE analysis_runs ADD COLUMN mapping_version TEXT NOT NULL DEFAULT 'unknown';
