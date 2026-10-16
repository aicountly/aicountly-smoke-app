"""7. Tata Smartflo click-to-call: a Flow agent presses "Call customer" on a ticket; Flow calls the
(stubbed, HTTPS) Smartflo click_to_call API with the documented payload; the stub then pushes the
call-status webhook to Flow's public endpoint and desk_calls is updated to completed."""

import json
import time

from harness import client, config, pg, services
from harness import fixtures as f

ID = "7"
TITLE = "Tata click-to-call: Flow call endpoint -> Smartflo stub (payload) -> stub webhook -> desk_calls updated"
SYSTEMS = "Flow, Tata Smartflo (stub), Console (SSO)"


def tata_records() -> list[dict]:
    p = services.TATA_OUT
    return [json.loads(x) for x in p.read_text().splitlines() if x.strip()] if p.exists() else []


def run(ctx):
    f.require("flow", "tata", "console")
    fdb = config.db("flow")
    k = services.keys()

    agent_console = f.console_superadmin()
    tok = f.flow_session(agent_console)["token"]
    tid = pg.scalar(fdb, "SELECT id FROM tickets ORDER BY id LIMIT 1")
    if not tid:
        tid = pg.scalar(fdb, "INSERT INTO tickets (ticket_number, title, description, priority, category, subcategory, problem_type, "
                             "product, created_via, status, portal_email, portal_name) VALUES ('TCK-2026-09901', 'Call me back', "
                             "'Please call', 'medium', 'core_workflows', 'daily_operations', 'other', 'general', 'email', 'open', "
                             "'caller@example.test', 'Caller') RETURNING id")
    ctx.step("ticket used", f"#{tid}")

    r = client.put(f"{f.FLOW()}/desk/me/call-phone", bearer=tok, json_body={"call_phone": "98765 43210"})
    ctx.check(r.status == 200, "agent saves the call-back number (PUT /api/desk/me/call-phone)", r.text[:120])

    before = len(tata_records())
    r = client.post(f"{f.FLOW()}/desk/tickets/{tid}/call", bearer=tok, json_body={"number": "+91 99887 76655"})
    d = (r.json or {}).get("data") or {}
    ctx.check(r.status == 201 and d.get("provider_call_id"), "Flow places the call (POST /api/desk/tickets/{id}/call)", r.text[:200])
    call_id = int(d["id"])

    reqs = [x for x in tata_records()[before:] if x["kind"] == "click_to_call"]
    ctx.check(len(reqs) == 1, "the Smartflo stub received exactly one click_to_call request", str(len(reqs)))
    req = reqs[0]
    ctx.check(req["path"] == "/v1/click_to_call" and req["authorization"] == k["tata_token"],
              "request: POST /v1/click_to_call over HTTPS, raw token in Authorization (no 'Bearer')", req["path"])
    ctx.check(req["body"] == {"agent_number": "919876543210", "destination_number": "919988776655",
                              "caller_id": "918069990000", "async": 1, "get_call_id": 1},
              "payload: agent_number, destination_number (digits with country code), caller_id, async, get_call_id",
              json.dumps(req["body"]))

    end = time.time() + 15
    row = None
    while time.time() < end:
        row = pg.json_rows(fdb, f"SELECT status, provider_call_id, answered_at, ended_at, duration_seconds, recording_url FROM desk_calls WHERE id = {call_id}")[0]
        if row["status"] == "completed":
            break
        time.sleep(0.3)
    hooks = [x for x in tata_records()[before:] if x["kind"] == "webhook_sent"]
    ctx.check(len(hooks) == 2 and all(h["flow_status"] == 200 for h in hooks),
              "the stub pushed ringing + answered webhooks to Flow's public endpoint, Flow answered 200", str([h["flow_status"] for h in hooks]))
    ctx.check(row["status"] == "completed" and row["provider_call_id"] == req["call_id"] and row["duration_seconds"] == 95
              and row["recording_url"].startswith("https://") and row["answered_at"] and row["ended_at"],
              "desk_calls updated: completed, Smartflo call id, 95 s, https recording link", json.dumps(row))

    acts = pg.rows(fdb, f"SELECT action FROM desk_activity_log WHERE entity_type = 'ticket' AND entity_id = {tid} AND action LIKE 'ticket.call%'")
    ctx.step("ticket activity entries", str([a[0] for a in acts]))
    r = client.post(f"{f.FLOW()}/public/telephony/tata/webhook", query={"token": k["tata_webhook"]},
                    json_body={"call_id": req["call_id"], "call_status": "answered", "billsec": "95"})
    ctx.check(r.status == 200, "a provider retry of the final webhook is harmless", f"HTTP {r.status}")
    ctx.check(pg.scalar(fdb, f"SELECT status FROM desk_calls WHERE id = {call_id}") == "completed", "the call stays completed")
    r = client.post(f"{f.FLOW()}/public/telephony/tata/webhook", query={"token": "WRONG"}, json_body={"call_id": req["call_id"], "call_status": "failed"})
    ctx.check(r.status == 401, "a webhook with the wrong token is refused", f"HTTP {r.status}")
    r = client.get(f"{f.FLOW()}/desk/tickets/{tid}/calls", bearer=tok)
    items = ((r.json or {}).get("data") or {}).get("items") or []
    ctx.check(r.status == 200 and any(int(i["id"]) == call_id and i["status"] == "completed" for i in items),
              "the ticket's Calls list shows the completed call", f"{len(items)} call(s)")
