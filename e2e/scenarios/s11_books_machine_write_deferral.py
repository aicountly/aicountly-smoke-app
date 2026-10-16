"""11. A machine write into a read-only company: a company's Books subscription lapses (Manage restricts it,
company_restricted delivered to Books); an Inventory-like sender (e2e/stubs/inventory_sender.php — Inventory
is not in this stack — signing like Inventory and using the lifecycle kit's own DeferredSend) posts an
inventory event batch to Books' machine route POST integration/inventory/events; Books answers 423
COMPANY_RESTRICTED, applies nothing and marks the event deferred_restricted; the sender keeps it deferred
(no attempt spent), and on its re-check asks Manage internal/company-status?app=books with its own product
key: still restricted -> wait; after the renewal -> resume, the event is delivered and Books records it."""

import json

from harness import client, config, pg, proc, services
from harness import fixtures as f

ID = "11"
TITLE = "Books machine write into a restricted company: Inventory-like sender -> 423 COMPANY_RESTRICTED -> deferred (kit DeferredSend) -> renewal -> resumed + delivered"
SYSTEMS = "Manage, Smart Books, Inventory-like sender (stub on the canonical lifecycle kit)"


def sender(args: list[str]) -> dict:
    k = services.keys()
    env = {
        "BOOKS_API_BASE": f.BOOKS(), "MANAGE_API_URL": config.url("manage"),
        "MANAGE_PRODUCT_SERVICE_KEY": k["manage_inventory_key"],
        "INVENTORY_INBOUND_SERVICE_KEY": k["inventory_inbound"], "INVENTORY_INBOUND_SIGNING_SECRET": k["inventory_signing"],
    }
    kit = config.src("manage") / "Saas Common Handler" / "company-lifecycle"
    state = config.STATE / "inventory-sender.json"
    p = proc.php_cli("inventory-sender", env, config.E2E_DIR / "stubs",
                     ["inventory_sender.php", f"--kit={kit}", f"--state={state}", *args])
    return json.loads(p.stdout.decode().strip().splitlines()[-1])


def run(ctx):
    f.require("portal", "manage", "books")
    mdb, bdb = config.db("manage"), config.db("books")
    k = services.keys()
    kit = config.src("manage") / "Saas Common Handler" / "company-lifecycle" / "src" / "DeferredSend.php"
    if not kit.exists():
        from harness.scenario import NotRun
        raise NotRun(f"the canonical lifecycle kit is not at {kit}")

    (config.STATE / "inventory-sender.json").unlink(missing_ok=True)   # the sender's outbox starts empty
    cust = f.customer("farah", 2011, "Farah", "Khan", "farah.khan@example.test", "9845002011")
    cid = f.manage_create_company(cust["ses"], "Khan Hardware Private Limited", "accounts@khan-hardware.example.test")
    fy = pg.scalar(mdb, f"SELECT fy_id FROM ghm_fy WHERE cmp_id = {cid} ORDER BY fy_id LIMIT 1")
    r = client.get(f"{f.BOOKS()}/access/me", bearer=cust["ses"], query={"cmp_id": cid, "fy_id": fy, "bo_id": 0}, timeout=180)
    ctx.check(r.status == 200, "owner opens the company in Books", f"cmp_id {cid}, HTTP {r.status}")

    r = client.post(f"{f.BOOKS()}/integration/inventory/events", headers={"X-Service-Key": k["inventory_inbound"], "X-Inventory-Signature": "t=1,v1=00"},
                    json_body={"events": []})
    ctx.check(r.status == 401, "Books refuses an Inventory call with a bad signature (signed mode)", f"HTTP {r.status}")

    r = client.post(f"{f.MANAGE()}/internal/subscriptions", bearer=k["manage_console_key"], json_body={
        "cmp_id": cid, "app_key": "books", "kind": "paid", "status": "cancelled", "current_period_end": "2026-10-05T00:00:00Z", "source": "manual"})
    f.manage_cli(["scripts/company_lifecycle.php", "--apply"])
    f.manage_cli(["scripts/product_events.php", "--deliver"])
    st = pg.json_rows(bdb, f"SELECT state FROM books_company_lifecycle WHERE company_id = {cid}")
    ctx.check(r.status == 200 and st and st[0]["state"] == "restricted",
              "the Books subscription lapsed: Manage restricted the company and Books stored company_restricted", str(st))

    out = sender(["enqueue", f"--cmp={cid}", "--type=inventory.uom.upserted", '--payload={"unit_id": 9001, "unit_name": "Box", "unit_symbol": "BOX"}'])
    eid = out["enqueued"]["event_id"]
    out = sender(["run"])
    sent = out["sent"][0] if out["sent"] else {}
    body = sent.get("body") or {}
    ctx.check(sent.get("http") == 423 and body.get("code") == "COMPANY_RESTRICTED" and body.get("lifecycle") == "restricted" and body.get("restricted_until"),
              "Books answers the machine write 423 COMPANY_RESTRICTED (lifecycle, restricted_until) — POST integration/inventory/events",
              json.dumps(body)[:260])
    data = body.get("data") or []
    ctx.check(data and data[0].get("status") == "deferred_restricted" and data[0].get("event_id") == eid,
              "  the event itself is reported deferred_restricted in data[]", json.dumps(data)[:200])
    ctx.check(pg.scalar(bdb, f"SELECT count(*) FROM books_inventory_events WHERE event_id = '{eid}'") == "0",
              "Books applied and recorded nothing for the restricted company")
    ev = out["events"][0]
    ctx.check(ev["status"] == "deferred_restricted" and ev["attempts"] == 0 and ev["restricted_until"] and ev["next_check_at"],
              "the sender keeps it deferred_restricted, no attempt spent, a re-check time set (kit DeferredSend::classify)",
              json.dumps({x: ev[x] for x in ("status", "attempts", "restricted_until", "next_check_at")}))

    out = sender(["run"])
    ctx.check(out["sent"] == [] and out["reviewed"] == [] and out["events"][0]["status"] == "deferred_restricted",
              "before its re-check time the sender sends nothing and asks nobody")
    out = sender(["run", "--recheck-now"])
    rv = out["reviewed"][0] if out["reviewed"] else {}
    ctx.check(rv.get("action") == "wait" and out["sent"] == [] and out["events"][0]["status"] == "deferred_restricted",
              "the (simulated) hourly re-check asks Manage company-status?app=books with the sender's key: still restricted -> wait",
              json.dumps(rv)[:240])

    r = client.post(f"{f.MANAGE()}/internal/subscriptions", bearer=k["manage_console_key"], json_body={
        "cmp_id": cid, "app_key": "books", "status": "active", "current_period_end": "2027-10-31T23:59:59Z", "source": "manual"})
    f.manage_cli(["scripts/product_events.php", "--deliver"])
    st = pg.json_rows(bdb, f"SELECT state FROM books_company_lifecycle WHERE company_id = {cid}")
    ctx.check(r.status == 200 and st and st[0]["state"] == "active", "operator records the renewal; company_unrestricted reaches Books", str(st))

    out = sender(["run", "--recheck-now"])
    rv = out["reviewed"][0] if out["reviewed"] else {}
    sent = out["sent"][0] if out["sent"] else {}
    ctx.check(rv.get("action") == "resume" and "active" in (rv.get("reason") or ""),
              "the re-check: Manage reports the company active for Books -> resume", json.dumps(rv)[:200])
    ctx.check(sent.get("http") == 200 and out["events"][0]["status"] == "delivered",
              "the deferred event is delivered (200) — nothing lost", json.dumps(sent.get("body"))[:200])
    row = pg.json_rows(bdb, f"SELECT status FROM books_inventory_events WHERE event_id = '{eid}'")
    ctx.check(len(row) == 1 and row[0]["status"] in ("processed", "ignored"),
              "Books recorded the event once it arrived (books_inventory_events)", str(row))
    out = sender(["run", "--recheck-now"])
    ctx.check(out["sent"] == [] and out["events"][0]["status"] == "delivered", "nothing left in the sender's outbox")
