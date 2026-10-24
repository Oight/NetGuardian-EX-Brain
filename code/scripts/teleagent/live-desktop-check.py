"""Explicitly authorized Windows desktop experiment; never used by product startup.

The reviewed historical helper supplies a local signer only in this Python
process. No credential, header, provider config or other conversation is saved.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import time

sys.dont_write_bytecode = True
HELPER_SHA256 = "9c5d8f7bdecd90dbf610049b04d6e5e57ee9bf7eef2c276ff9633cf58b259c8a"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--authorized-desktop-test", action="store_true")
    parser.add_argument("--research-helper", type=Path, required=True)
    parser.add_argument("--run-dir", type=Path, required=True)
    args = parser.parse_args()
    if not args.authorized_desktop_test:
        raise RuntimeError("Explicit current authorization is required")
    helper = args.research_helper.resolve()
    if hashlib.sha256(helper.read_bytes()).hexdigest() != HELPER_SHA256:
        raise RuntimeError("The helper differs from the reviewed historical source")
    root = args.run_dir.resolve()
    root.mkdir(parents=True, exist_ok=True)
    counter = root / "model-submissions.json"
    used = (
        json.loads(counter.read_text(encoding="utf-8"))["submitted"]
        if counter.exists()
        else 0
    )
    if used:
        raise RuntimeError(
            "This authorized two-task experiment has already started; no automatic retry"
        )
    sys.path.insert(0, str(helper.parent))
    spec = importlib.util.spec_from_file_location("reviewed_desktop_helper", helper)
    assert spec and spec.loader
    access = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(access)
    # Enumerate only the desktop backend, then its own Node siblings.
    rows = access.powershell_json(
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); "
        "Get-CimInstance Win32_Process -Filter \"Name='TeleAgent.exe'\" | "
        "Select-Object Name,ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress"
    )
    rows = rows if isinstance(rows, list) else [rows]
    candidates = [
        r for r in rows if "super-agent-code" in (r.get("ExecutablePath") or "").lower()
    ]
    if len(candidates) != 1:
        raise RuntimeError("A unique running TeleAgent backend was not found")
    backend = candidates[0]
    with Path(backend["ExecutablePath"]).open("rb") as stream:
        if (
            hashlib.file_digest(stream, "sha256").hexdigest()
            != "632ae07bf98e976dc18fb0118feb9bc38be35e1c31352c06621757c55ed60184"
        ):
            raise RuntimeError(
                "The running backend differs from the verified 2.7.0 sample"
            )
    parent = int(backend["ParentProcessId"])
    nodes = access.powershell_json(
        "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); "
        f"Get-CimInstance Win32_Process -Filter \"Name='node.exe' AND ParentProcessId={parent}\" | "
        "Select-Object Name,ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
    )
    nodes = nodes if isinstance(nodes, list) else [nodes]
    nodes = [
        n
        for n in nodes
        if "teleagent" in (n.get("ExecutablePath") or "").lower()
        and "im-service" in (n.get("CommandLine") or "").lower()
    ]
    if len(nodes) != 1:
        raise RuntimeError("A unique verified TeleAgent IM sibling was not found")
    key = access.read_runtime_signing_key(nodes[0])
    ports = access.powershell_json(
        f"Get-NetTCPConnection -State Listen -OwningProcess {int(backend['ProcessId'])} | "
        "Select-Object LocalAddress,LocalPort | ConvertTo-Json -Compress"
    )
    ports = ports if isinstance(ports, list) else [ports]
    from teleagent_client import TeleAgentClient

    workspace = root / "workspace"
    workspace.mkdir(exist_ok=True)
    client = None
    for port in sorted(
        {
            p["LocalPort"]
            for p in ports
            if p.get("LocalAddress") in ("127.0.0.1", "::1", "0.0.0.0", "::")
        }
    ):
        probe = TeleAgentClient(f"http://127.0.0.1:{port}", key, str(workspace))
        try:
            probe.request("GET", "/session/status")
            client = probe
            break
        except Exception:
            probe.close()
    del key
    if client is None:
        raise RuntimeError("No authenticated loopback backend")
    result = {
        "scope": "two authorized new desktop conversations; no global config changes",
        "credentials_saved": False,
        "other_conversations_read": False,
        "real_model": True,
        "real_tools": False,
        "tests": [],
    }
    current_session = None
    try:
        config = client.request("GET", "/config")
        providers = client.request("GET", "/provider")
        agent = "opencowork-default"
        if agent not in config.get("agent", {}) or config["agent"][agent].get(
            "disable"
        ):
            raise RuntimeError("The verified desktop primary agent is unavailable")
        if "NewApi" not in providers.get("connected", []):
            raise RuntimeError("The desktop model provider is not connected")
        model_id = providers.get("default", {}).get("NewApi")
        if not isinstance(model_id, str) or not model_id:
            raise RuntimeError("No configured desktop model")
        model = {"providerID": "NewApi", "modelID": model_id}
        del config, providers
        result["model_route"] = model
        for kind in ("text", "cancel"):
            marker = "CAMPUSSEC-LIVE-" + kind + "-" + str(time.time_ns())
            prompt = (
                "这是用户授权的合成连通性测试。不要调用工具，不要读取文件或写入记忆。"
                "证据 E-SYN-001：一条被阻断请求；E-SYN-002：两次登录失败。"
                "没有成功登录、主机执行或数据访问证据。请在150字内区分事实、推断和未知，"
                "引用两个证据ID，最后原样输出标记：" + marker
                if kind == "text"
                else "这是用户授权的取消链路测试。不要调用工具或写入记忆。"
                "请连续输出1000行合成占位编号，不涉及真实资料；测试程序会中止。标记："
                + marker
            )
            session = client.request(
                "POST",
                "/session",
                body={
                    "title": "[校安智脑接入验证] " + kind + " " + marker,
                    "permission": [
                        {"permission": "*", "pattern": "*", "action": "deny"}
                    ],
                },
            )
            sid = session["id"]
            current_session = sid
            used += 1
            counter.write_text(json.dumps({"submitted": used}), encoding="utf-8")
            client.request(
                "POST",
                f"/session/{sid}/prompt_async",
                body={
                    "agent": agent,
                    "model": model,
                    "parts": [{"type": "text", "text": prompt}],
                },
            )
            print(
                json.dumps({"phase": "submitted", "kind": kind, "session_id": sid}),
                flush=True,
            )
            deadline = time.monotonic() + 90
            user_id, final, abort_sent = None, None, False
            while time.monotonic() < deadline:
                messages = client.messages(sid)
                users = [
                    m
                    for m in messages
                    if m.get("info", {}).get("role") == "user"
                    and any(
                        p.get("type") == "text" and p.get("text") == prompt
                        for p in m.get("parts", [])
                    )
                ]
                if len(users) == 1:
                    user_id = users[0]["info"]["id"]
                replies = [
                    m
                    for m in messages
                    if m.get("info", {}).get("role") == "assistant"
                    and user_id
                    and m["info"].get("parentID") == user_id
                ]
                if any(
                    p.get("type") == "tool"
                    for m in messages
                    for p in m.get("parts", [])
                ):
                    raise RuntimeError(
                        "A denied test session unexpectedly invoked a tool"
                    )
                if kind == "cancel" and replies and not abort_sent:
                    if any(
                        p.get("type") == "text" and p.get("text")
                        for m in replies
                        for p in m.get("parts", [])
                    ):
                        client.abort(sid)
                        abort_sent = True
                terminals = [
                    m
                    for m in replies
                    if m["info"].get("error")
                    or (
                        m["info"].get("time", {}).get("completed")
                        and m["info"].get("finish")
                        not in (None, "tool_calls", "tool-calls", "tool_use")
                    )
                ]
                if terminals:
                    final = terminals[-1]
                    break
                time.sleep(0.2)
            if not final:
                client.abort(sid)
                raise RuntimeError(
                    "The authorized task did not reach a correlated terminal state"
                )
            info = final["info"]
            error_name = (info.get("error") or {}).get("name")
            text = "\n".join(
                p.get("text", "")
                for p in final.get("parts", [])
                if p.get("type") == "text"
            )
            item = {
                "kind": kind,
                "session_id": sid,
                "user_message_id": user_id,
                "result_message_id": info["id"],
                "parent_matched": info.get("parentID") == user_id,
                "finish": info.get("finish"),
                "error_name": error_name,
                "completed": bool(info.get("time", {}).get("completed")),
                "no_tools": True,
                "tokens": info.get("tokens"),
            }
            if kind == "text":
                item["reply"] = text
                item["passed"] = (
                    not error_name
                    and info.get("finish") == "stop"
                    and marker in text
                    and all(e in text for e in ("E-SYN-001", "E-SYN-002"))
                )
                # A noReply append is tested only in this now-idle test conversation.
                receipt_marker = "CAMPUSSEC-RECEIPT-" + marker
                before = len(
                    [
                        m
                        for m in client.messages(sid)
                        if m["info"].get("role") == "assistant"
                    ]
                )
                client.request(
                    "POST",
                    f"/session/{sid}/prompt_async",
                    body={
                        "agent": agent,
                        "model": model,
                        "noReply": True,
                        "parts": [{"type": "text", "text": receipt_marker}],
                    },
                )
                time.sleep(0.5)
                appended = client.messages(sid)
                matching = [
                    m
                    for m in appended
                    if any(p.get("text") == receipt_marker for p in m.get("parts", []))
                ]
                item["idle_no_reply_append_visible"] = len(matching) == 1
                item["idle_append_did_not_trigger_assistant"] = before == len(
                    [m for m in appended if m["info"].get("role") == "assistant"]
                )
                item["append_role"] = matching[0]["info"]["role"] if matching else None
            else:
                item["abort_sent"] = abort_sent
                item["passed"] = abort_sent and error_name == "MessageAbortedError"
            result["tests"].append(item)
            print(
                json.dumps(
                    {"phase": "observed", "kind": kind, "passed": item["passed"]}
                ),
                flush=True,
            )
            current_session = None
            if not item["passed"]:
                raise RuntimeError(
                    "The authorized desktop task failed its observation checks"
                )
        result["status"] = "passed"
        return 0
    except Exception as error:
        if current_session:
            try:
                client.abort(current_session)
            except Exception:
                pass
        result["status"] = "failed"
        result["failure_type"] = type(error).__name__
        return 1
    finally:
        result["submitted_model_tasks"] = used
        (root / "report.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        client.close()
        print(
            json.dumps(
                {
                    "status": result["status"],
                    "submitted_model_tasks": used,
                    "report": str(root / "report.json"),
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    raise SystemExit(main())
