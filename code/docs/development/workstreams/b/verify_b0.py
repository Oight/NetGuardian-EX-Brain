"""Verify B0 planning materials and native DDL, never product-service behavior.

Standard library only. No network, model, product dependencies or persistent DB.
Scenario expected values are future acceptance oracles, not executed outcomes.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from urllib.parse import unquote

HERE = Path(__file__).resolve().parent
CODE = HERE.parents[3]
ROOT = CODE.parent
MODULES = {"S02", "S05", "S06", "S10"}
INTERFACES = {
    "DatabasePort": "S02", "EventPort": "S02", "AlertService": "S05",
    "CaseService": "S06", "CaseAtomicPort": "S06",
    "ReportService": "S10", "ResultPackageReadPort": "S10",
}


def require(condition: object, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def check_spec() -> None:
    spec = CODE / "spec"
    for entry in read_json(spec / "provenance.json")["files"]:
        actual = hashlib.sha256((spec / entry["name"]).read_bytes()).hexdigest()
        require(actual == entry["sha256"], f"Frozen specification changed: {entry['name']}")
    require((spec / "schema.sql").read_bytes() ==
            (CODE / "packages/storage/migrations/0001.sql").read_bytes(), "Initial migration differs from frozen DDL")


def check_materials(directory: Path = HERE) -> tuple[int, int, int]:
    mapping = read_json(directory / "b0-mapping.json")
    fixtures = read_json(directory / "b0-fixtures.json")
    scenarios = read_json(directory / "b0-scenarios.json")["scenarios"]
    require(mapping["engineeringContract"] == fixtures["engineeringContract"] == "0.2.0", "Wrong engineering baseline")
    require(mapping["businessBaseline"] == fixtures["businessBaseline"] == "v4.2", "Wrong business baseline")
    require(mapping["wireVersion"] == fixtures["wireVersion"] == "0.1.0", "Wrong wire baseline")
    require(fixtures["synthetic"] is True, "Fixtures must be explicitly synthetic")
    owners = read_json(CODE / "spec/architecture.json")["tableOwners"]
    expected_tables = {(owner, name) for owner in MODULES for name in owners[owner]}
    actual_tables = [(row["module"], row["name"]) for row in mapping["tables"]]
    require(len(actual_tables) == len(set(actual_tables)), "Duplicate table mapping")
    require(set(actual_tables) == expected_tables, "Missing, foreign or incorrectly owned table mapping")

    source = (CODE / "spec/contracts.ts").read_text(encoding="utf-8")
    expected_ports = set()
    for interface, module in INTERFACES.items():
        block = re.search(rf"^export interface {interface}\s*\{{([\s\S]*?)^\}}", source, re.M)
        require(block is not None, f"Missing frozen interface: {interface}")
        for method in re.findall(r"^  (\w+)(?:<[^\n>]+>)?\(", block[1], re.M):
            expected_ports.add((module, interface, method))
    actual_ports = [(row["module"], row["interface"], row["method"]) for row in mapping["ports"]]
    require(len(actual_ports) == len(set(actual_ports)), "Duplicate port mapping")
    require(set(actual_ports) == expected_ports, "Missing, foreign or stale method mapping")
    for alias, (interface, methods) in mapping["aliases"].items():
        declaration = re.search(rf"export type {alias} = Pick<(\w+), ([^;]+)>;", source)
        require(declaration is not None and declaration[1] == interface, f"Invalid narrow port: {alias}")
        require(set(re.findall(r"'([^']+)'", declaration[2])) == set(methods), f"Stale narrow port: {alias}")

    by_id = {row["id"]: row for row in scenarios}
    require(len(by_id) == len(scenarios), "Duplicate scenario ID")
    port_names = {f"{interface}.{method}" for _, interface, method in expected_ports}
    referenced = set()
    for row in mapping["tables"] + mapping["ports"]:
        require(row["scenarios"], "Mapping without an acceptance scenario")
        for scenario_id in row["scenarios"]:
            require(scenario_id in by_id, f"Missing scenario: {scenario_id}")
            referenced.add(scenario_id)
        if "interface" in row:
            method = f"{row['interface']}.{row['method']}"
            require(all(method in by_id[n]["ports"] for n in row["scenarios"]), f"Scenario does not exercise {method}")
            require(bool(row["tx"]), f"Missing transaction boundary: {method}")
        else:
            require(bool(row["plannedWriter"]), f"Missing writer: {row['name']}")
    require(referenced == set(by_id), "Unmapped acceptance scenario")
    for row in scenarios:
        require(row["module"] in MODULES and row["phase"] in {"B1", "B2", "B3", "B4"}, f"Wrong scenario scope: {row['id']}")
        require(row["execution"] == "planned_product_acceptance", "Scenario must not claim executed product success")
        require(row["ports"] and set(row["ports"]) <= port_names, f"Unknown scenario port: {row['id']}")
        require(row["given"] and row["when"] and row["expected"], f"Scenario lacks input/action/oracle: {row['id']}")
        for ref in row["fixtureRefs"]:
            value = fixtures
            for key in ref.split("."):
                require(isinstance(value, dict) and key in value, f"Broken fixture reference: {row['id']} -> {ref}")
                value = value[key]
        gap = row["expected"].get("requiresDecision")
        require(gap is None or gap in mapping["gaps"], f"Unknown interface request: {gap}")
    check_fixtures(fixtures)
    return len(actual_tables), len(actual_ports), len(scenarios)


def check_fixtures(f: dict) -> None:
    """Check material integrity and intentional counterexamples, not service rules."""
    require(len(set(f["ids"].values())) == len(f["ids"]), "Duplicate synthetic identity")
    require(all(re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", value)
                for value in f["ids"].values()), "Malformed synthetic UUID")
    require(f["scopes"]["single"]["agentIds"] == ["001"], "Native agent identity was changed")
    require(f["records"]["missingTime"]["timeQuality"] == "unknown" and
            "observedAt" not in f["records"]["missingTime"], "Unknown-time counterexample was lost")
    for page in f["pages"].values():
        require(page["coverage"]["returned"] == len(page["records"]), "Page count differs from its records")
        require(page["coverage"]["effectiveScope"] == f["scopes"]["single"], "Fixture scope association drift")
    require(f["pages"]["partial"]["coverage"]["queryCompleteness"] == "partial", "Partial counterexample was lost")
    require(f["pages"]["empty"]["status"] == "ok" and not f["pages"]["empty"]["records"], "Zero-match input changed")
    require(f["pages"]["denied"]["coverage"]["queryCompleteness"] == "not_executed", "Denied became zero-match")
    require(f["pages"]["alerts"]["records"][0]["kind"] == "alert", "Alert polling uses the wrong source kind")
    for p in f["projections"].values():
        # Fixtures use only plain JSON with ASCII keys, integers and strings.
        data = json.dumps(p["content"], ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        require(hashlib.sha256(data).hexdigest() == p["contentHash"], "Fixture projection hash mismatch")
        require(p["ref"] == f["refs"]["one"] and p["runId"] == f["ids"]["run"], "Fixture projection association mismatch")
    require(f["projections"]["prepared"]["state"] == "prepared" and
            "releasedAt" not in f["projections"]["prepared"], "Unreleased counterexample was lost")
    require(f["projections"]["released"]["state"] == "released", "Valid reference is not released")
    require(f["candidates"]["bounded"]["facts"][0]["evidenceRefs"][0]["projectionId"] == f["projections"]["released"]["id"], "Bounded candidate reference mismatch")
    require(f["candidates"]["unreleased"]["facts"][0]["evidenceRefs"][0]["projectionId"] == f["projections"]["prepared"]["id"], "Prepared-reference counterexample was lost")
    require(f["candidates"]["crossRun"]["runId"] != f["validationInputs"]["current"]["view"]["runId"], "Cross-run counterexample was lost")
    require(f["candidates"]["unknownEvidence"]["facts"][0]["evidenceRefs"][0]["evidenceId"] != f["ids"]["evidence"], "Unknown-reference counterexample was lost")
    require(not f["candidates"]["zeroMatches"]["facts"][0]["evidenceRefs"], "Zero-match fixture invented evidence")
    require(f["businessContexts"]["unverified"]["authorId"] == f["contexts"]["ui"]["actor"]["principalId"], "Context author mismatch")
    require(f["businessContexts"]["unverified"]["verification"] == "unverified", "Unverified background became verified")
    require(not f["frozenInputs"]["noSeed"]["seedRefs"], "No-seed input gained invented seeds")
    require("runId" not in f["resultPackages"]["cancelBeforeRun"], "Pre-run cancellation invented a run")
    require(f["resultPackages"]["review"]["review"] == "unreviewed", "Candidate validity became human approval")


def check_links() -> int:
    paths = list(HERE.glob("*.md")) + [CODE / "docs/development/tasks/T003-b-local-domain.md"]
    count = 0
    for path in paths:
        text = path.read_text(encoding="utf-8")
        require("\ufffd" not in text and text.count("```") % 2 == 0, f"Invalid Markdown encoding/fences: {path.name}")
        for target in re.findall(r"!?\[[^\]\n]*\]\(([^)\n]+)\)", text):
            if re.match(r"^(?:[A-Za-z][A-Za-z0-9+.-]*:|#)", target):
                continue
            local = unquote(target.split("#", 1)[0])
            if local:
                require((path.parent / local).resolve().exists(), f"Broken link: {path.name} -> {local}")
                count += 1
    return count


def check_native_ddl() -> int:
    """SQL probes exercise the frozen schema, not DatabasePort/CaseService/etc."""
    f = read_json(HERE / "b0-fixtures.json")
    ids, now = f["ids"], f["clock"]
    encoded = lambda value: json.dumps(value, separators=(",", ":"))
    count = 0
    with tempfile.TemporaryDirectory(prefix="campussec-b0-") as directory:
        filename = Path(directory) / "synthetic.sqlite"
        db = sqlite3.connect(filename)
        try:
            db.executescript((CODE / "spec/schema.sql").read_text(encoding="utf-8"))
            require(db.execute("PRAGMA foreign_keys").fetchone()[0] == 1, "Foreign keys disabled")
            require(db.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone()[0] == 49, "DDL table count changed")
            require(db.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal", "WAL unavailable")
            db.execute("INSERT INTO connections(id,platform_instance_id,display_name,generation,alerts_pattern,mapping_version,principal_fingerprint,updated_at) VALUES(?,?,?,?,?,?,?,?)", (ids["connection"], ids["platform"], "synthetic", 1, "synthetic-*", "v1", "synthetic", now))
            db.execute("INSERT INTO cases(id,revision,title,connection_id,scope_json,status,created_at,updated_at) VALUES(?,1,?,?,?,'pending',?,?)", (ids["case"], "Synthetic case", ids["connection"], encoded(f["scopes"]["single"]), now, now))
            db.execute("INSERT INTO evidence_sources VALUES(?,?,?,?)", ("synthetic-source-key", ids["evidence"], ids["connection"], encoded(f["records"]["authentication"]["source"])))
            db.execute("INSERT INTO evidence_versions(evidence_id,version,kind,time_quality,retrieved_at,content_hash,fields_json) VALUES(?,1,'authentication','unknown',?,?,?)", (ids["evidence"], now, "synthetic-hash", "{}"))
            for request_id in [ids["request"], ids["otherCase"]]:
                db.execute("INSERT INTO investigation_requests(id,origin,state,principal_id,connection_id,question,seed_refs_json,missing_fields_json,created_at,expires_at) VALUES(?,'client_user','accepted',?,?,'synthetic','[]','[]',?,?)", (request_id, ids["principal"], ids["connection"], now, now))
            db.execute("INSERT INTO jobs(id,request_id,case_id,origin,state,revision,expires_at,created_at,updated_at) VALUES(?,?,?,'client_user','running',1,?,?,?)", (ids["job"], ids["request"], ids["case"], now, now, now))
            db.execute("INSERT INTO analysis_runs(id,job_id,case_id,base_revision,scope_json,connection_generation,identity_epoch,profile_version,tool_epoch,expires_at,initial_input_json) VALUES(?,?,?,1,?,1,1,'synthetic',1,?,?)", (ids["run"], ids["job"], ids["case"], encoded(f["scopes"]["single"]), now, encoded(f["frozenInputs"]["noSeed"])))
            db.execute("INSERT INTO query_runs(id,connection_id,query_json,coverage_json,status,created_at) VALUES(?,?,?,?,'partial',?)", (ids["query"], ids["connection"], encoded(f["queries"]["authentication"]), encoded(f["pages"]["partial"]["coverage"]), now))
            db.execute("INSERT INTO query_pages(page_id,query_id,page_ordinal,content_hash,coverage_json) VALUES(?,?,0,'hash','{}')", (ids["page"], ids["query"]))
            db.execute("INSERT INTO notifications VALUES('notification-1','notification-key','[]','pending',?)", (now,))
            db.execute("INSERT INTO report_drafts VALUES(?,?,?,1,1,?,'valid','unreviewed','[]',?)", (ids["report"], ids["case"], ids["run"], encoded(f["candidates"]["bounded"]), now))
            db.execute("INSERT INTO result_packages VALUES(?,?,1,?,?)", (ids["request"], ids["run"], encoded(f["resultPackages"]["review"]), now))
            db.commit()

            probes = [
                ("duplicate source key", "INSERT INTO evidence_sources VALUES(?,?,?,?)", ("synthetic-source-key", ids["otherEvidence"], ids["connection"], "{}"), "evidence_sources.source_key"),
                ("missing evidence FK", "INSERT INTO evidence_links VALUES(?,?,1,1,NULL)", (ids["case"], ids["otherEvidence"]), "FOREIGN KEY"),
                ("duplicate query ordinal", "INSERT INTO query_pages VALUES(?,?,0,'different','{}',NULL)", (ids["otherPage"], ids["query"]), "query_pages.query_id"),
                ("duplicate notification key", "INSERT INTO notifications VALUES('notification-2','notification-key','[]','pending',?)", (now,), "notifications.notification_key"),
                ("duplicate report version", "INSERT INTO report_drafts VALUES('report-2',?,?,1,1,'{}','invalid','unreviewed','[]',?)", (ids["case"], ids["run"], now), "report_drafts.run_id"),
                ("duplicate result version", "INSERT INTO result_packages VALUES(?,?,1,'{}',?)", (ids["request"], ids["run"], now), "result_packages.request_id"),
                ("uncertain occupies active slot", "INSERT INTO jobs(id,request_id,case_id,origin,state,revision,expires_at,created_at,updated_at) VALUES('job-2',?,?,'client_user','uncertain',1,?,?,?)", (ids["otherCase"], ids["case"], now, now, now), "uq_one_active_job"),
            ]
            for name, sql, parameters, error_text in probes:
                db.execute("SAVEPOINT probe")
                try:
                    db.execute(sql, parameters)
                except sqlite3.IntegrityError as error:
                    require(error_text in str(error), f"Unexpected constraint for {name}: {error}")
                    count += 1
                else:
                    raise AssertionError(f"DDL accepted {name}")
                finally:
                    db.execute("ROLLBACK TO probe")
                    db.execute("RELEASE probe")

            db.execute("SAVEPOINT cas_probe")
            first = db.execute("UPDATE cases SET revision=revision+1 WHERE id=? AND revision=1", (ids["case"],)).rowcount
            second = db.execute("UPDATE cases SET revision=revision+1 WHERE id=? AND revision=1", (ids["case"],)).rowcount
            require((first, second) == (1, 0), "CAS SQL conditions do not detect stale revision")
            db.execute("ROLLBACK TO cas_probe")
            db.execute("RELEASE cas_probe")
            count += 1
            db.execute("SAVEPOINT rollback_probe")
            db.execute("UPDATE cases SET revision=2 WHERE id=?", (ids["case"],))
            db.execute("INSERT INTO domain_events(event_type,aggregate_id,revision,trace_id,occurred_at,payload_json) VALUES('case.changed',?,2,?,?,'{}')", (ids["case"], ids["trace"], now))
            db.execute("ROLLBACK TO rollback_probe")
            db.execute("RELEASE rollback_probe")
            require(db.execute("SELECT revision FROM cases").fetchone()[0] == 1 and
                    db.execute("SELECT COUNT(*) FROM domain_events").fetchone()[0] == 0, "Business/event rollback failed")
            count += 1
            require(not db.execute("PRAGMA foreign_key_check").fetchall(), "Invalid synthetic FK dependencies")
            require(db.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "Temporary DB integrity failed")
        finally:
            db.close()
        with closing(sqlite3.connect(filename)) as reopened:
            require(reopened.execute("SELECT revision FROM cases").fetchone()[0] == 1, "Committed synthetic row lost on reopen")
            count += 1
    return count


def main() -> None:
    check_spec()
    tables, ports, scenarios = check_materials()
    links = check_links()
    probes = check_native_ddl()
    print(f"PASS B0 materials: {tables} owned tables; {ports} methods; {scenarios} planned scenarios; {links} local links.")
    print(f"PASS native DDL only: {probes} SQLite probes, including constraints/CAS/rollback/reopen; SQLite {sqlite3.sqlite_version}.")
    print("NOT EXECUTED: product services, Zod/typecheck/build, Electron, Wazuh, host/model/MCP or delivery. Scenario expected results are not product passes.")


if __name__ == "__main__":
    main()
