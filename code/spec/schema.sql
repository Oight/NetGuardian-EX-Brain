-- 设计附件 0.2.0（2026-10-23）；每个主体空间独立数据库；仅核心进程可打开写连接。
-- JSON 列由运行时 schema 校验；业务状态以关系列为准。
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE space_metadata(space_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, identity_epoch INTEGER NOT NULL CHECK(identity_epoch>0));
CREATE TABLE runtime_settings(key TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), value_json TEXT NOT NULL);
CREATE TABLE connections(
  id TEXT PRIMARY KEY, platform_instance_id TEXT NOT NULL, display_name TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>0), indexer_base_url TEXT, server_base_url TEXT,
  indexer_secret_ref TEXT, server_secret_ref TEXT, ca_ref TEXT,
  alerts_pattern TEXT NOT NULL, archives_pattern TEXT, mapping_version TEXT NOT NULL,
  principal_fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE capabilities(
  connection_id TEXT NOT NULL REFERENCES connections(id), name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('available','denied','unreachable','unsupported','unverified')),
  checked_at TEXT NOT NULL, evidence TEXT NOT NULL, endpoint_kind TEXT NOT NULL,
  PRIMARY KEY(connection_id,name)
);
CREATE TABLE cases(
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0), title TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id), scope_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','investigating','resolved','reopened')),
  current_report_id TEXT, latest_report_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE case_changes(
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), revision INTEGER NOT NULL,
  reason TEXT NOT NULL, actor_id TEXT NOT NULL, change_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(case_id,revision)
);
CREATE TABLE evidence_sources(
  source_key TEXT PRIMARY KEY, evidence_id TEXT NOT NULL UNIQUE,
  connection_id TEXT NOT NULL REFERENCES connections(id), locator_json TEXT NOT NULL
);
CREATE TABLE evidence_versions(
  evidence_id TEXT NOT NULL REFERENCES evidence_sources(evidence_id), version INTEGER NOT NULL CHECK(version>0),
  kind TEXT NOT NULL, observed_at TEXT, time_quality TEXT NOT NULL,
  retrieved_at TEXT NOT NULL, content_hash TEXT NOT NULL, fields_json TEXT NOT NULL,
  availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','expired')),
  PRIMARY KEY(evidence_id,version)
);
CREATE TABLE evidence_retrievals(
  id TEXT PRIMARY KEY, evidence_id TEXT NOT NULL, version INTEGER NOT NULL, retrieved_at TEXT NOT NULL,
  query_id TEXT, FOREIGN KEY(evidence_id,version) REFERENCES evidence_versions(evidence_id,version)
);
CREATE TABLE evidence_links(
  case_id TEXT NOT NULL REFERENCES cases(id), evidence_id TEXT NOT NULL, evidence_version INTEGER NOT NULL,
  attached_revision INTEGER NOT NULL, removed_revision INTEGER,
  PRIMARY KEY(case_id,evidence_id,evidence_version),
  FOREIGN KEY(evidence_id,evidence_version) REFERENCES evidence_versions(evidence_id,version)
);
CREATE TABLE business_context(
  id TEXT PRIMARY KEY, case_id TEXT REFERENCES cases(id), connection_id TEXT NOT NULL REFERENCES connections(id),
  latest_version INTEGER NOT NULL
);
CREATE TABLE context_versions(
  context_id TEXT NOT NULL REFERENCES business_context(id), version INTEGER NOT NULL,
  agent_ids_json TEXT NOT NULL, text TEXT NOT NULL, department TEXT, purpose TEXT,
  valid_from TEXT NOT NULL, valid_to TEXT NOT NULL, source_label TEXT NOT NULL,
  verification TEXT NOT NULL CHECK(verification IN ('unverified','verified','rejected')), author_id TEXT NOT NULL,
  PRIMARY KEY(context_id,version)
);
CREATE TABLE query_runs(
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id), run_id TEXT, case_id TEXT REFERENCES cases(id),
  query_json TEXT NOT NULL, coverage_json TEXT NOT NULL, status TEXT NOT NULL,
  sealed INTEGER NOT NULL DEFAULT 0 CHECK(sealed IN (0,1)), created_at TEXT NOT NULL
);
CREATE TABLE query_pages(
  page_id TEXT PRIMARY KEY, query_id TEXT NOT NULL REFERENCES query_runs(id), page_ordinal INTEGER NOT NULL,
  content_hash TEXT NOT NULL, coverage_json TEXT NOT NULL, next_cursor_ref TEXT,
  UNIQUE(query_id,page_ordinal)
);
CREATE TABLE query_evidence(
  query_id TEXT NOT NULL REFERENCES query_runs(id), evidence_id TEXT NOT NULL, evidence_version INTEGER NOT NULL,
  PRIMARY KEY(query_id,evidence_id,evidence_version),
  FOREIGN KEY(evidence_id,evidence_version) REFERENCES evidence_versions(evidence_id,version)
);
CREATE TABLE alerts_inbox(
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id), source_key TEXT NOT NULL,
  receive_seq INTEGER NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('realtime','history','recovery')),
  evidence_id TEXT NOT NULL, evidence_version INTEGER NOT NULL, agent_id TEXT, rule_id TEXT,
  rule_groups_json TEXT NOT NULL, level INTEGER, observed_at TEXT, received_at TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0, decision_reason TEXT NOT NULL,
  UNIQUE(connection_id,source_key),
  FOREIGN KEY(evidence_id,evidence_version) REFERENCES evidence_versions(evidence_id,version)
);
CREATE TABLE watch_checkpoints(
  connection_id TEXT PRIMARY KEY REFERENCES connections(id), completed_upper TEXT,
  receive_seq INTEGER NOT NULL, state TEXT NOT NULL, gap_json TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE trigger_policies(
  id TEXT PRIMARY KEY, connection_id TEXT NOT NULL UNIQUE REFERENCES connections(id), revision INTEGER NOT NULL,
  epoch INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  enabled_after_receive_seq INTEGER NOT NULL, policy_json TEXT NOT NULL
);
CREATE TABLE auto_candidates(
  id TEXT PRIMARY KEY, policy_id TEXT NOT NULL REFERENCES trigger_policies(id), policy_epoch INTEGER NOT NULL,
  case_id TEXT NOT NULL REFERENCES cases(id), group_key TEXT NOT NULL, first_received_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL, coalesce_until TEXT NOT NULL, expires_at TEXT NOT NULL,
  state TEXT NOT NULL, candidate_json TEXT NOT NULL
);
CREATE INDEX idx_candidate_group ON auto_candidates(policy_id,policy_epoch,group_key,last_received_at);
CREATE TABLE trigger_decisions(
  id TEXT PRIMARY KEY, alert_id TEXT NOT NULL REFERENCES alerts_inbox(id), policy_id TEXT,
  policy_epoch INTEGER NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL,
  candidate_id TEXT REFERENCES auto_candidates(id), created_at TEXT NOT NULL,
  UNIQUE(alert_id,policy_epoch)
);
CREATE TABLE notifications(
  id TEXT PRIMARY KEY, notification_key TEXT NOT NULL UNIQUE, alert_ids_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','shown','uncertain','muted')), created_at TEXT NOT NULL
);
CREATE TABLE origin_bindings(
  id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, host_id TEXT NOT NULL, host_account_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, request_message_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','revoked','expired')), created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE investigation_requests(
  id TEXT PRIMARY KEY, origin TEXT NOT NULL CHECK(origin IN ('alert_auto','client_user','teleagent_user')),
  state TEXT NOT NULL CHECK(state IN ('awaiting_scope','accepted','rejected','withdrawn')),
  principal_id TEXT NOT NULL, connection_id TEXT NOT NULL REFERENCES connections(id), question TEXT NOT NULL,
  requested_scope_json TEXT, effective_scope_json TEXT, seed_refs_json TEXT NOT NULL,
  case_id TEXT REFERENCES cases(id), job_id TEXT, origin_binding_id TEXT REFERENCES origin_bindings(id),
  auto_candidate_id TEXT REFERENCES auto_candidates(id), missing_fields_json TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE request_keys(
  principal_id TEXT NOT NULL, origin_key TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL, request_id TEXT NOT NULL REFERENCES investigation_requests(id),
  PRIMARY KEY(principal_id,origin_key,idempotency_key)
);
CREATE TABLE request_events(
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES investigation_requests(id),
  event_type TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE deferred_inputs(
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES investigation_requests(id),
  input_key TEXT NOT NULL, text TEXT NOT NULL, consumed_by_request_id TEXT REFERENCES investigation_requests(id),
  created_at TEXT NOT NULL, UNIQUE(request_id,input_key)
);
CREATE TABLE result_subscriptions(
  request_id TEXT NOT NULL REFERENCES investigation_requests(id), binding_id TEXT NOT NULL REFERENCES origin_bindings(id),
  can_cancel INTEGER NOT NULL CHECK(can_cancel IN (0,1)), state TEXT NOT NULL,
  PRIMARY KEY(request_id,binding_id)
);
CREATE TABLE jobs(
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES investigation_requests(id),
  case_id TEXT NOT NULL REFERENCES cases(id), run_id TEXT UNIQUE,
  origin TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN (
    'coalescing','queued','preparing','submitting','running','verifying','succeeded',
    'needs_review','failed','cancel_requested','cancelled','uncertain')),
  revision INTEGER NOT NULL, recovery_hold INTEGER NOT NULL DEFAULT 0 CHECK(recovery_hold IN (0,1)),
  policy_id TEXT REFERENCES trigger_policies(id), policy_epoch INTEGER,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error_json TEXT
);
CREATE UNIQUE INDEX uq_one_active_job ON jobs((1)) WHERE state IN ('preparing','submitting','running','verifying','cancel_requested','uncertain');
CREATE INDEX idx_jobs_queue ON jobs(state,origin,created_at);
CREATE TABLE analysis_runs(
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), case_id TEXT NOT NULL REFERENCES cases(id),
  base_revision INTEGER NOT NULL, scope_json TEXT NOT NULL, connection_generation INTEGER NOT NULL,
  identity_epoch INTEGER NOT NULL, profile_version TEXT NOT NULL, tool_epoch INTEGER NOT NULL,
  expires_at TEXT NOT NULL, initial_input_json TEXT NOT NULL, prepared_profile_json TEXT,
  completion_decision_json TEXT, manifest_hash TEXT, sealed_at TEXT
);
CREATE TABLE run_evidence(
  run_id TEXT NOT NULL REFERENCES analysis_runs(id), evidence_id TEXT NOT NULL, evidence_version INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('seed','tool')), PRIMARY KEY(run_id,evidence_id,evidence_version),
  FOREIGN KEY(evidence_id,evidence_version) REFERENCES evidence_versions(evidence_id,version)
);
CREATE TABLE evidence_projections(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analysis_runs(id), evidence_id TEXT NOT NULL,
  evidence_version INTEGER NOT NULL, content_json TEXT NOT NULL, content_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','released','uncertain')), prepared_at TEXT NOT NULL, released_at TEXT,
  availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','expired')),
  FOREIGN KEY(evidence_id,evidence_version) REFERENCES evidence_versions(evidence_id,version)
);
CREATE TABLE run_event_keys(
  run_id TEXT NOT NULL REFERENCES analysis_runs(id), source_key TEXT NOT NULL, PRIMARY KEY(run_id,source_key)
);
CREATE TABLE quota_ledger(
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), run_id TEXT REFERENCES analysis_runs(id),
  connection_id TEXT NOT NULL REFERENCES connections(id), origin TEXT NOT NULL, local_date TEXT NOT NULL,
  time_zone TEXT NOT NULL, attempt INTEGER NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL,
  usage_json TEXT, created_at TEXT NOT NULL, UNIQUE(job_id,attempt,kind)
);
CREATE TABLE tool_reservations(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analysis_runs(id), tool_name TEXT NOT NULL,
  tool_ordinal INTEGER NOT NULL, is_read INTEGER NOT NULL, expires_at TEXT NOT NULL,
  tool_epoch INTEGER NOT NULL, identity_epoch INTEGER NOT NULL, connection_generation INTEGER NOT NULL,
  UNIQUE(run_id,tool_ordinal)
);
CREATE TABLE platform_attempts(
  id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES tool_reservations(id),
  run_id TEXT NOT NULL REFERENCES analysis_runs(id), attempted_at TEXT NOT NULL
);
CREATE TABLE execution_attempts(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analysis_runs(id), attempt INTEGER NOT NULL,
  operation TEXT NOT NULL, phase TEXT NOT NULL, host_identity_json TEXT NOT NULL,
  session_id TEXT, user_message_id TEXT, result_message_id TEXT, snapshot_json TEXT,
  intent_at TEXT NOT NULL, observed_at TEXT, UNIQUE(run_id,attempt,operation)
);
CREATE TABLE mcp_grants(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES analysis_runs(id), role TEXT NOT NULL,
  token_digest TEXT NOT NULL UNIQUE, secret_ref TEXT NOT NULL, tool_epoch INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','active','revoked')), binding_json TEXT,
  expires_at TEXT NOT NULL
);
CREATE TABLE mcp_calls(
  id TEXT PRIMARY KEY, transport_binding_id TEXT NOT NULL, call_id TEXT NOT NULL,
  argument_hash TEXT NOT NULL, tool_name TEXT NOT NULL, run_id TEXT REFERENCES analysis_runs(id),
  reservation_id TEXT REFERENCES tool_reservations(id), state TEXT NOT NULL,
  reply_json TEXT, projection_ids_json TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(transport_binding_id,call_id)
);
CREATE TABLE investigation_steps(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES analysis_runs(id),
  phase TEXT NOT NULL, summary TEXT NOT NULL, purpose TEXT, evidence_refs_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE report_drafts(
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), run_id TEXT NOT NULL REFERENCES analysis_runs(id),
  version INTEGER NOT NULL, base_revision INTEGER NOT NULL, candidate_json TEXT NOT NULL,
  validation TEXT NOT NULL CHECK(validation IN ('valid','invalid','needs_review')),
  review TEXT NOT NULL CHECK(review IN ('unreviewed','accepted','revised','rejected')),
  validation_issues_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(run_id,version)
);
CREATE TABLE reviews(
  id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES report_drafts(id), case_revision INTEGER NOT NULL,
  disposition TEXT NOT NULL, human_conclusion TEXT NOT NULL, note TEXT NOT NULL,
  revised_report_id TEXT REFERENCES report_drafts(id), author_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE followups(
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), report_id TEXT REFERENCES report_drafts(id),
  revision INTEGER NOT NULL, question TEXT NOT NULL, suggested_action TEXT NOT NULL, responsible_role TEXT,
  state TEXT NOT NULL CHECK(state IN ('open','waiting','completed')), due_at TEXT, note TEXT,
  evidence_refs_json TEXT NOT NULL
);
CREATE TABLE response_notes(
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), followup_id TEXT REFERENCES followups(id),
  source TEXT NOT NULL CHECK(source IN ('human_statement','observed')), text TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL, author_id TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE result_packages(
  request_id TEXT NOT NULL REFERENCES investigation_requests(id), run_id TEXT REFERENCES analysis_runs(id),
  result_version INTEGER NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(request_id,result_version)
);
CREATE TABLE result_deliveries(
  id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES origin_bindings(id),
  request_id TEXT NOT NULL, run_id TEXT, result_version INTEGER NOT NULL,
  delivery_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','sending','delivered','uncertain','retryable_failed','blocked')),
  attempts INTEGER NOT NULL, receipt_json TEXT, last_error_json TEXT, next_attempt_at TEXT,
  FOREIGN KEY(request_id,result_version) REFERENCES result_packages(request_id,result_version)
);
CREATE TABLE domain_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  revision INTEGER NOT NULL, trace_id TEXT NOT NULL, occurred_at TEXT NOT NULL, payload_json TEXT NOT NULL
);
CREATE INDEX idx_events_aggregate ON domain_events(aggregate_id,seq);
CREATE TABLE diagnostic_events(
  id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, code TEXT NOT NULL, safe_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE cleanup_plans(
  id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, plan_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('preview','applied','expired')), expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
