"""Offline design checks; --sync updates generated excerpts in new design docs only."""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DESIGN = ROOT / "docs" / "implementation"
CONTRACT = DESIGN / "contracts.ts"
SCHEMA = DESIGN / "schema.sql"
COMMON = {"ClockPort", "IdPort", "DEFAULT_LIMITS", "ENGINEERING_CONTRACT_VERSION", "WIRE_SCHEMA_VERSION"}


def declarations(source: str) -> dict[str, str]:
    starts = list(re.finditer(r"^export (?:type|interface|const) (\w+)", source, re.M))
    assert len({match[1] for match in starts}) == len(starts), "Duplicate exported contract name"
    result = {}
    for index, match in enumerate(starts):
        end = starts[index + 1].start() if index + 1 < len(starts) else len(source)
        result[match[1]] = source[match.start():end].strip()
    return result


def closure(roots: set[str], blocks: dict[str, str]) -> set[str]:
    missing = roots - blocks.keys()
    if missing:
        raise ValueError(f"Unknown roots: {sorted(missing)}")
    selected, pending = set(), list(roots)
    while pending:
        name = pending.pop()
        if name in selected:
            continue
        selected.add(name)
        refs = set(re.findall(r"\b[A-Za-z_$][\w$]*\b", blocks[name])) & blocks.keys()
        pending.extend(refs - selected)
    return selected


def sql_excerpt(source: str, roots: str) -> str:
    tables = {m[1]: m[0] for m in re.finditer(r"CREATE TABLE (\w+)\([\s\S]*?\);", source)}
    if roots == "*":
        return source.strip()
    selected = set(roots.split(","))
    if selected - tables.keys():
        raise ValueError(f"Unknown SQL table: {selected - tables.keys()}")
    pending = list(selected)
    while pending:
        name = pending.pop()
        for ref in re.findall(r"REFERENCES (\w+)", tables[name]):
            if ref not in selected:
                selected.add(ref)
                pending.append(ref)
    parts = ["PRAGMA foreign_keys = ON;"]
    for match in re.finditer(r"CREATE (?:TABLE (\w+)|(?:UNIQUE )?INDEX \w+ ON (\w+))[\s\S]*?;", source):
        if (match[1] or match[2]) in selected:
            parts.append(match[0])
    return "\n\n".join(parts)


def update_or_check(path: Path, blocks: dict[str, str], source: str, schema: str, sync: bool) -> None:
    text = path.read_text(encoding="utf-8")

    def contract_block(match: re.Match) -> str:
        roots = match[1]
        if roots == "*":
            code = source.strip()
        else:
            selected = closure(set(roots.split(",")) | COMMON, blocks)
            code = "\n\n".join(value for name, value in blocks.items() if name in selected)
        return f"<!-- CONTRACT:BEGIN roots={roots} -->\n```typescript\n{code}\n```\n<!-- CONTRACT:END -->"

    def sql_block(match: re.Match) -> str:
        roots = match[1] or "*"
        marker = "" if roots == "*" else f" tables={roots}"
        code = sql_excerpt(schema, roots)
        return f"<!-- SQL:BEGIN{marker} -->\n```sql\n{code}\n```\n<!-- SQL:END -->"

    updated = re.sub(r"<!-- CONTRACT:BEGIN roots=([^ ]+) -->[\s\S]*?<!-- CONTRACT:END -->", contract_block, text)
    updated = re.sub(r"<!-- SQL:BEGIN(?: tables=([^ ]+))? -->[\s\S]*?<!-- SQL:END -->", sql_block, updated)
    if updated != text:
        if not sync:
            raise AssertionError(f"Stale generated excerpt: {path.relative_to(ROOT)}")
        path.write_text(updated, encoding="utf-8", newline="\n")
    if path.name[:2].isdigit():
        assert "CONTRACT:BEGIN" in updated, f"No independent contract: {path.name}"
        for heading in ("范围", "验收", "契约"):
            assert heading in updated, f"Missing {heading}: {path.name}"
    for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", updated):
        if re.match(r"(?:https?://|#)", target):
            continue
        target = target.split("#", 1)[0]
        assert (path.parent / target).resolve().exists(), f"Broken link in {path.name}: {target}"
    assert updated.count("```") % 2 == 0, f"Unbalanced code fences: {path.name}"
    for code in re.findall(r"```sql\n([\s\S]*?)\n```", updated):
        db = sqlite3.connect(":memory:")
        db.executescript(code)
        names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for name in names:
            for fk in db.execute(f'PRAGMA foreign_key_list("{name}")'):
                assert fk[2] in names, f"Missing standalone FK dependency: {path.name}: {fk[2]}"
        db.close()


def check_node_syntax(docs: list[Path]) -> int:
    count = 0
    with tempfile.TemporaryDirectory(prefix="campussec-design-") as directory:
        paths = [CONTRACT]
        for doc in docs:
            text = doc.read_text(encoding="utf-8")
            blocks = re.findall(r"<!-- CONTRACT:BEGIN[^\n]*-->\n```typescript\n([\s\S]*?)\n```", text)
            for index, code in enumerate(blocks):
                path = Path(directory) / f"{doc.stem}-{index}.ts"
                path.write_text(code, encoding="utf-8")
                paths.append(path)
        for path in paths:
            result = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True, encoding="utf-8")
            assert result.returncode == 0, f"Node TypeScript syntax: {path.name}\n{result.stderr}"
            count += 1
    return count


def expect_integrity(db: sqlite3.Connection, sql: str, parameters: tuple = ()) -> None:
    try:
        db.execute(sql, parameters)
    except sqlite3.IntegrityError:
        return
    raise AssertionError(f"Expected integrity rejection: {sql}")


def check_database(schema: str) -> int:
    db = sqlite3.connect(":memory:")
    db.executescript(schema)
    db.execute("INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
        "connection", "platform", "synthetic", 1, None, None, None, None, None,
        "synthetic-alerts-*", None, "synthetic-v1", "synthetic-principal", "2026-10-22T12:00:00.000Z"))
    db.execute("INSERT INTO cases VALUES(?,?,?,?,?,?,?,?,?,?)", (
        "case", 1, "synthetic", "connection", "{}", "pending", None, None, "now", "now"))
    db.execute("INSERT INTO evidence_sources VALUES(?,?,?,?)", ("source", "evidence", "connection", "{}"))
    db.execute("INSERT INTO evidence_versions(evidence_id,version,kind,observed_at,time_quality,retrieved_at,content_hash,fields_json) VALUES(?,?,?,?,?,?,?,?)", ("evidence", 1, "alert", None, "unknown", "now", "hash", "{}"))
    expect_integrity(db, "INSERT INTO evidence_sources VALUES(?,?,?,?)", ("source", "other", "connection", "{}"))
    expect_integrity(db, "INSERT INTO evidence_links VALUES(?,?,?,?,?)", ("case", "missing", 1, 1, None))
    for index in (1, 2):
        db.execute("""INSERT INTO investigation_requests
            (id,origin,state,principal_id,connection_id,question,seed_refs_json,missing_fields_json,created_at,expires_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)""", (f"request{index}", "client_user", "accepted", "principal", "connection", "synthetic?", "[]", "[]", "now", "later"))
    db.execute("INSERT INTO request_keys VALUES(?,?,?,?,?)", ("principal", "client", "key", "hash", "request1"))
    expect_integrity(db, "INSERT INTO request_keys VALUES(?,?,?,?,?)", ("principal", "client", "key", "different", "request2"))
    job_sql = """INSERT INTO jobs(id,request_id,case_id,origin,state,revision,expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)"""
    db.execute(job_sql, ("job1", "request1", "case", "client_user", "uncertain", 1, "later", "now", "now"))
    expect_integrity(db, job_sql, ("job2", "request2", "case", "client_user", "running", 1, "later", "now", "now"))
    db.execute("UPDATE jobs SET state='needs_review',revision=revision+1 WHERE id='job1' AND revision=1")
    db.execute(job_sql, ("job2", "request2", "case", "client_user", "running", 1, "later", "now", "now"))
    assert db.execute("UPDATE cases SET revision=2 WHERE id='case' AND revision=1").rowcount == 1
    assert db.execute("UPDATE cases SET revision=2 WHERE id='case' AND revision=1").rowcount == 0
    db.execute("INSERT INTO origin_bindings VALUES(?,?,?,?,?,?,?,?,?,?)", ("binding", "principal", "host", "account", "workspace", "session", "message", "active", "now", "later"))
    db.execute("INSERT INTO result_packages VALUES(?,?,?,?,?)", ("request1", None, 1, "{}", "now"))
    delivery_sql = """INSERT INTO result_deliveries(id,binding_id,request_id,run_id,result_version,delivery_key,state,attempts)
        VALUES(?,?,?,?,?,?,?,?)"""
    db.execute(delivery_sql, ("delivery1", "binding", "request1", None, 1, "key", "pending", 0))
    expect_integrity(db, delivery_sql, ("delivery2", "binding", "request1", None, 1, "key", "pending", 0))
    db.commit()
    db.execute("BEGIN IMMEDIATE")
    db.execute("UPDATE cases SET title='rollback' WHERE id='case'")
    db.execute("INSERT INTO domain_events(event_type,aggregate_id,revision,trace_id,occurred_at,payload_json) VALUES('case.changed','case',3,'trace','now','{}')")
    db.rollback()
    assert db.execute("SELECT title FROM cases WHERE id='case'").fetchone()[0] == "synthetic"
    assert db.execute("SELECT COUNT(*) FROM domain_events").fetchone()[0] == 0
    assert not db.execute("PRAGMA foreign_key_check").fetchall()
    assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    count = db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone()[0]
    db.close()
    return count


def check_vectors(blocks: dict[str, str]) -> None:
    vector = json.loads((DESIGN / "contract-vectors.json").read_text(encoding="utf-8"))
    assert vector["schemaVersion"] == "0.1.0"
    assert vector["contractVersion"] == "0.2.0"
    for name in ("emptyComplete", "denied", "partial"):
        payload = vector[name]
        assert len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) <= 16384
        assert payload["coverage"]["collectionCoverage"] == "unknown"
    assert vector["emptyComplete"]["coverage"]["queryCompleteness"] == "complete"
    assert vector["denied"]["coverage"]["queryCompleteness"] == "not_executed"
    assert vector["partial"]["coverage"]["queryCompleteness"] == "partial"
    assert "total" not in vector["denied"]["coverage"]
    for type_name, key in (("JobState", "jobTransitions"), ("DeliveryState", "deliveryTransitions")):
        states = set(re.findall(r"'([^']+)'", blocks[type_name]))
        transitions = vector[key]
        assert set(transitions) == states, f"State drift: {type_name}"
        assert all(set(targets) <= states for targets in transitions.values())
    assert all(not vector["jobTransitions"][state] for state in ("succeeded", "needs_review", "failed", "cancelled"))
    assert not vector["deliveryTransitions"]["delivered"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sync", action="store_true")
    parser.add_argument("--node-syntax", action="store_true", help="Use installed Node's TypeScript syntax parser; no code execution or type checking")
    args = parser.parse_args()
    source, schema = CONTRACT.read_text(encoding="utf-8"), SCHEMA.read_text(encoding="utf-8")
    blocks = declarations(source)
    assert len(blocks) >= 60
    for name in blocks:
        closure({name}, blocks)
    docs = sorted(DESIGN.glob("*.md"))
    assert len([p for p in docs if p.name[:2].isdigit()]) == 12
    for path in docs:
        update_or_check(path, blocks, source, schema, args.sync)
    count = check_database(schema)
    check_vectors(blocks)
    print(f"PASS: {len(docs)} documents; {len(blocks)} contract declarations; {count} SQL tables; excerpts, links, synthetic vectors and transaction constraints.")
    if args.node_syntax:
        syntax_count = check_node_syntax(docs)
        print(f"PASS: Node --check parsed {syntax_count} TypeScript specification/excerpt files (syntax only, not tsc type checking).")
    print("Offline design checks only; no TypeScript compiler, Electron build, network, model or live platform validation is performed by this script.")


if __name__ == "__main__":
    main()
