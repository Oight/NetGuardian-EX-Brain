"""Read-only, offline checks of the engineering and collaboration specifications.

No product code, secrets, migration sources, models or platform endpoints are read.
The graph validates the declared design, not nonexistent source-code dependencies.
"""
from __future__ import annotations

import ast
import json
import re
from pathlib import Path
from urllib.parse import unquote

from verify_subsystem_designs import declarations

ROOT = Path(__file__).resolve().parents[2]
DESIGN = ROOT / "docs/implementation"


def check_links() -> tuple[int, int]:
    # AGENTS.md is machine-local and ignored; shared checks must not require it.
    paths = [ROOT / "README.md", ROOT / "CONTRIBUTING.md"]
    paths += sorted((ROOT / "docs").rglob("*.md"))
    paths += sorted((ROOT / ".github").rglob("*.md"))
    count = 0
    for path in paths:
        source = path.read_text(encoding="utf-8")
        assert "\ufffd" not in source, f"Replacement character: {path.relative_to(ROOT)}"
        assert source.count("```") % 2 == 0, f"Unbalanced code fences: {path}"
        for target in re.findall(r"!?\[[^\]\n]*\]\(([^)\n]+)\)", source):
            if re.match(r"^(?:[A-Za-z][A-Za-z0-9+.-]*:|#)", target):
                continue
            target = unquote(target.split("#", 1)[0])
            if target:
                assert (path.parent / target).resolve().exists(), f"Broken local link: {path.relative_to(ROOT)} -> {target}"
                count += 1
    return len(paths), count


def check_boundaries() -> tuple[int, int]:
    spec = json.loads((DESIGN / "architecture.json").read_text(encoding="utf-8"))
    blocks = declarations((DESIGN / "contracts.ts").read_text(encoding="utf-8"))
    assert spec["contractVersion"] == "0.2.0"
    assert spec["businessBaseline"] == "v4.2" and spec["wireVersion"] == "0.1.0"
    assert spec["enforcementStatus"] == "specification-only"
    components = spec["components"]
    seen, visiting = set(), set()

    def visit(name: str) -> None:
        assert name in components, f"Unknown component: {name}"
        assert name not in visiting, f"Cyclic declared dependency through {name}"
        if name in seen:
            return
        visiting.add(name)
        component = components[name]
        assert re.fullmatch(r"S(?:0[1-9]|1[0-2])", component["module"])
        for port in component["ports"]:
            assert port in blocks, f"Unknown contract: {name}/{port}"
        for dependency in component["dependsOn"]:
            visit(dependency)
        visiting.remove(name)
        seen.add(name)

    for name in components:
        visit(name)
    schema = (DESIGN / "schema.sql").read_text(encoding="utf-8")
    tables = set(re.findall(r"^CREATE TABLE (\w+)", schema, re.M))
    owners: dict[str, str] = {}
    for module, names in spec["tableOwners"].items():
        for name in names:
            assert name not in owners, f"Duplicate table owner: {name}"
            owners[name] = module
    assert set(owners) == tables, f"Table ownership drift: {tables ^ set(owners)}"
    assert owners["mcp_calls"] == owners["investigation_steps"] == "S07"
    assert spec["tableOwners"]["S09"] == ["mcp_grants"]
    for path in DESIGN.glob("[0-9][0-9]-*.md"):
        source = path.read_text(encoding="utf-8")
        prefix = source.split("<!-- CONTRACT:BEGIN", 1)[0]
        assert "工程契约版本：0.2.0" in prefix, f"Stale engineering header: {path.name}"
        marker = re.search(r"<!-- SQL:BEGIN tables=([^ ]+) -->", source)
        if marker:
            declared = set(marker[1].split(","))
            assert declared == set(spec["tableOwners"]["S" + path.name[:2]]), f"SQL ownership roots drift: {path.name}"

    # Check actual shared declarations, rather than promises in prose.
    assert "ExecutionSnapshot" not in blocks["ReportService"]
    assert "JobRecord" not in blocks["ReportService"]
    assert "CompletionDecision" in blocks["ReportService"]
    assert "publishReview(" not in blocks["ReportService"]
    for method in ("openChannel", "bindChannel", "revoke", "acknowledgeReply"):
        assert method not in blocks["McpGatewayPort"], f"Wide gateway API leaked: {method}"
    assert "ResultPackage" not in blocks["HostDeliveryPort"]
    assert "HostMessage" in blocks["HostDeliveryPort"]
    assert "parentMatched" not in blocks["ExecutionSnapshot"]
    assert "normalFinish" not in blocks["ExecutionSnapshot"]
    assert "verification" in blocks["ExecutionSnapshot"]
    assert "reserveTool" not in blocks["RequestService"]
    assert "transportBindingId" in blocks["InvestigationToolPort"]
    for field in ("toolEpoch", "identityEpoch", "connectionGeneration"):
        assert field in blocks["BudgetReservation"]
    for field in ("prepared_profile_json", "completion_decision_json"):
        assert field in schema
    assert "ResultPackageReadPort" in components["reports"]["ports"]
    assert "reports" in components["delivery"]["dependsOn"]
    assert set(components["cases"]["dependsOn"]) == {"common", "storage"}
    assert not {"requests", "tools", "execution", "delivery"} & set(components["reports"]["dependsOn"])
    return len(components), len(tables)


def check_workflow_and_rules() -> None:
    expected = ("README.md", "workflow.md", "engineering-rules.md", "ownership.md", "task-template.md", "readiness.md", "github.md")
    for name in expected:
        assert (ROOT / "docs/development" / name).is_file()
    workflow = (ROOT.parent / ".github/workflows/foundation.yml").read_text(encoding="utf-8")
    assert not re.search(r"^(?:<{7}(?: .*)?|={7}|>{7}(?: .*)?)$", workflow, re.M), "Unresolved workflow merge markers"
    assert "workflow_dispatch:" in workflow and "\n  push:" not in workflow and "\n  pull_request:" not in workflow
    assert "working-directory: code" in workflow and "working-directory: design_document" in workflow
    assert "cache-dependency-path: code/package-lock.json" in workflow
    assert "npm ci --ignore-scripts" in workflow
    assert "contents: read" in workflow and "persist-credentials: false" in workflow
    assert "pull_request_target" not in workflow and "secrets." not in workflow
    assert "--sync" not in workflow and "migration/verify_materials" not in workflow
    uses = re.findall(r"uses: ([^\s]+)", workflow)
    assert uses and all(re.fullmatch(r"actions/[a-z-]+@[0-9a-f]{40}", value) for value in uses)
    for script in (ROOT / "scripts/design").glob("*.py"):
        ast.parse(script.read_text(encoding="utf-8"), filename=script.name)


def main() -> None:
    documents, links = check_links()
    components, tables = check_boundaries()
    check_workflow_and_rules()
    print(f"PASS: {documents} Markdown files; {links} local links; {components} declared components form a DAG; {tables} tables each have one owner; contract boundaries and workflow checks.")
    print("Specification checks only: no product import/SQL-access enforcement, runtime schemas, tsc, Electron build, GitHub run, model or live platform validation.")


if __name__ == "__main__":
    main()
