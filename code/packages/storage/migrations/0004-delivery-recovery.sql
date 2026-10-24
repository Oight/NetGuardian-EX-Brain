-- Additive S11 maintenance audit; the frozen 0001/0002 migrations remain unchanged.
CREATE TABLE delivery_recoveries(
  delivery_id TEXT NOT NULL REFERENCES result_deliveries(id),
  trace_id TEXT NOT NULL, identity_epoch INTEGER NOT NULL,
  expected_state TEXT NOT NULL CHECK(expected_state IN ('blocked','uncertain','retryable_failed')),
  expected_attempts INTEGER NOT NULL CHECK(expected_attempts>=0),
  action TEXT NOT NULL CHECK(action IN ('pending','delivered')),
  reason TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(delivery_id,trace_id)
);
