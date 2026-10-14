"""6. Flow -> Build handoff: a Flow admin hands an approved bug to Build; Flow's BuildApiClient POSTs
Build's v1/tasks (Flow-inbound bearer); Build answers 201 and records a dev request; Build's own
admin API (Console SSO -> Build session) returns the stored payloads as JSON arrays/objects."""

from harness import client, config, pg, services
from harness import fixtures as f

ID = "6"
TITLE = "Flow -> Build handoff: approved bug -> BuildApiClient -> Build POST v1/tasks 201 -> GET returns arrays"
SYSTEMS = "Flow, Build, Console (SSO into both)"


def run(ctx):
    f.require("flow", "build", "console")
    fdb, bdb = config.db("flow"), config.db("build")

    admin_console = f.console_superadmin()
    flow = f.flow_session(admin_console)
    tok = flow["token"]
    r = client.post(f"{f.FLOW()}/desk/bugs", bearer=tok, json_body={
        "title": "Bank reconciliation crashes on HDFC CSV", "description": "Parser fails on DD/MM/YYYY dates.",
        "product": "smart_books", "category": "core_workflows", "subcategory": "daily_operations",
        "problem_type": "crash_error", "severity": "high"})
    bug = ((r.json or {}).get("data") or {}).get("id")
    ctx.check(r.status == 201 and bug, "Flow admin files the bug (POST /api/desk/bugs)", f"bug #{bug}")
    r = client.post(f"{f.FLOW()}/desk/bugs/{bug}/status", bearer=tok, json_body={"status": "approved"})
    ctx.step("bug status -> approved", f"HTTP {r.status}")

    payload = {"title": "Fix HDFC CSV date parsing", "description": "Approved bug from Flow", "priority": "high",
               "product": "smart_books", "acceptance": ["parses DD/MM/YYYY", "re-import works"],
               "labels": {"area": "bank-reconciliation", "customer_impact": "high"}}
    r = client.post(f"{f.FLOW()}/desk/build-handoffs", bearer=tok,
                    json_body={"source_type": "bug", "source_id": bug, "payload": payload})
    hid = ((r.json or {}).get("data") or {}).get("id")
    ctx.check(r.status == 201 and hid, "Flow queues + dispatches the handoff (POST /api/desk/build-handoffs)", f"handoff #{hid}")

    h = pg.json_rows(fdb, f"SELECT status, build_task_ref, response_payload, error_message, attempts FROM flow_build_handoffs WHERE id = {hid}")[0]
    ctx.check(h["status"] == "sent" and not h["error_message"], "Build accepted: Flow marks the handoff sent", str(h)[:300])
    resp = h["response_payload"] or {}
    dev_id = resp.get("dev_request_id")
    ctx.check(resp.get("created") is True and dev_id, "Build answered 201 'Handoff accepted' with a dev request id", str(resp))

    bh = pg.json_rows(bdb, f"SELECT flow_handoff_id, source_type, source_id, dev_request_id, status FROM build_flow_handoffs WHERE flow_handoff_id = {hid}")
    ctx.check(len(bh) == 1 and int(bh[0]["dev_request_id"]) == int(dev_id) and bh[0]["source_type"] == "bug",
              "Build DB: build_flow_handoffs row linked to the dev request", str(bh))
    ctx.check(str(h["build_task_ref"] or "") == str(dev_id),
              "Flow stores Build's task reference (flow_build_handoffs.build_task_ref)",
              f"build_task_ref={h['build_task_ref']!r}, Build answered build_task_ref={resp.get('build_task_ref')!r}")

    k = services.keys()
    r = client.post(f"{f.BUILD()}/v1/tasks", bearer="wrong-token", json_body={"flow_handoff_id": hid, "title": "x"})
    ctx.check(r.status == 401, "Build refuses a handoff without Flow's inbound token", f"HTTP {r.status}")
    r = client.post(f"{f.BUILD()}/v1/tasks", bearer=k["flow_build_inbound"],
                    json_body=payload | {"flow_handoff_id": hid, "source_type": "bug", "source_id": bug})
    ctx.check(r.status == 200 and ((r.json or {}).get("data") or {}).get("created") is False,
              "a redelivered handoff is deduplicated on flow_handoff_id (200, created=false)", f"HTTP {r.status}")

    b = f.build_session(admin_console)
    btok = b.get("token") or b.get("access_token")
    ctx.check(bool(btok), "superadmin opens Build through the Console launch key (Build /v1/auth/controller-sso)")
    r = client.get(f"{f.BUILD()}/v1/flow-handoffs", bearer=btok)
    rows = [x for x in ((r.json or {}).get("data") or []) if int(x.get("flow_handoff_id") or 0) == int(hid)]
    raw = rows[0].get("raw_payload") if rows else None
    ctx.check(r.status == 200 and isinstance(raw, dict) and isinstance(raw.get("acceptance"), list)
              and isinstance(raw.get("labels"), dict),
              "Build GET v1/flow-handoffs returns raw_payload as a JSON object with arrays (not a double-encoded string)",
              f"type(raw_payload)={type(raw).__name__}")
    r = client.get(f"{f.BUILD()}/v1/dev-requests/{dev_id}", bearer=btok)
    md = ((r.json or {}).get("data") or {}).get("metadata")
    ctx.check(r.status == 200 and isinstance(md, dict) and isinstance((md.get("raw") or {}).get("acceptance"), list),
              "Build GET v1/dev-requests/{id} returns metadata as an object, acceptance as an array", f"type(metadata)={type(md).__name__}")
