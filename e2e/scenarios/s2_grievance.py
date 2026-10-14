"""2. Grievance redressal across Manage and Flow: a customer raises a ticket in Manage's Help & Support
(written into the Flow database), Flow staff resolve it, the dissatisfied customer escalates to level 2
through Manage, and a Flow user who holds the Console role grievance_officer acknowledges and resolves
it through the Flow API. Every customer and officer e-mail is captured."""

import time

from harness import client, config, pg, services
from harness import fixtures as f

ID = "2"
TITLE = "Grievance: Manage desk ticket -> L2 escalation via Manage -> Flow officer (Console role) acks/resolves"
SYSTEMS = "my.aicountly, Manage, Flow (shared Flow DB), Console, e-mail"

OFFICER = ("Gita Officer", "gita.officer@aicountly.example", "Gita-e2e-Pass1!")


def run(ctx):
    f.require("portal", "manage", "flow", "console", "mail", "s3")
    fdb = config.db("flow")

    cust = f.customer("meera", 2001, "Meera", "Iyer", "meera.iyer@example.test", "9845002001")
    ctx.check(bool(cust["ses"]), "customer signs in through the real portal (auth/login + seskey)", f"uuid {cust['uuid']}")

    mark = f.mail_mark()
    r = client.post(f"{f.MANAGE()}/desk/tickets", bearer=cust["ses"], json_body={
        "title": "Bank reconciliation keeps failing",
        "description": "Every time I import my HDFC statement the reconciliation screen errors out.",
        "product": "smart_books", "category": "core_workflows", "subcategory": "daily_operations",
        "problem_type": "other", "priority": "medium"})
    d = (r.json or {}).get("data") or {}
    ctx.check(r.status == 201 and d.get("ticket_id"), "Manage POST /api/desk/tickets creates the ticket (session validated by the portal)", r.text[:200])
    tid, tnum = int(d["ticket_id"]), d["ticket_number"]
    row = pg.json_rows(fdb, f"SELECT status, portal_uuid, portal_email, created_via, grievance_level FROM tickets WHERE id = {tid}")
    ctx.check(row and row[0]["portal_uuid"] == cust["uuid"] and row[0]["created_via"] == "product_portal",
              "the ticket is a row in the FLOW database, owned by the portal uuid", str(row))
    shot = client.png(16, 12)
    body, ctype = client.multipart({}, {"file": ("reconciliation-error.png", "image/png", shot)})
    r = client.post(f"{f.MANAGE()}/desk/tickets/{tid}/attachments", bearer=cust["ses"], data=body, headers={"Content-Type": ctype})
    att = pg.json_rows(fdb, f"SELECT attachment_id, storage_key, file_size FROM desk_attachments WHERE entity_type = 'ticket' AND entity_id = {tid}")
    ctx.check(r.status == 201 and len(att) == 1 and int(att[0]["file_size"]) == len(shot),
              "customer attaches a screenshot through Manage: stored in the Flow bucket (moto), row in the Flow DB",
              f"HTTP {r.status} {att}")
    r = client.post(f"{f.MANAGE()}/desk/tickets/{tid}/notify-created", bearer=cust["ses"])
    m = f.wait_mail(lambda m: m["to"] == cust["email"] and tnum in m["subject"], mark)
    ctx.check(r.status == 200 and m is not None, "Manage e-mails the customer about the new ticket", m["subject"] if m else "no mail")

    # Flow staff (superadmin via Console SSO) resolve it.
    admin = f.flow_session(f.console_superadmin())
    r = client.get(f"{f.FLOW()}/desk/attachments/{att[0]['attachment_id']}", bearer=admin["token"])
    ctx.check(r.status == 200 and r.body == shot, "Flow staff download the customer's screenshot byte for byte (Manage wrote, Flow reads)",
              f"HTTP {r.status}, {len(r.body)} bytes")
    r = client.put(f"{f.FLOW()}/desk/tickets/{tid}/status", bearer=admin["token"],
                   json_body={"status": "resolved", "comment": "Fixed the statement parser for HDFC."})
    ctx.check(r.status == 200 and pg.scalar(fdb, f"SELECT status FROM tickets WHERE id = {tid}") == "resolved",
              "Flow staff resolve the ticket (PUT /api/desk/tickets/{id}/status)", f"HTTP {r.status}")

    r = client.get(f"{f.MANAGE()}/desk/tickets/{tid}", bearer=cust["ses"])
    elig = (((r.json or {}).get("data") or {}).get("grievance") or {})
    ctx.step("Manage shows the customer the escalation eligibility", str(elig)[:300])

    mark = f.mail_mark()
    r = client.post(f"{f.MANAGE()}/desk/tickets/{tid}/escalate", bearer=cust["ses"],
                    json_body={"reason": "The reconciliation still fails with the same error after the fix."})
    d = (r.json or {}).get("data") or {}
    ref = f"{tnum}-L2"
    ctx.check(r.status == 201 and d.get("reference") == ref and int(d.get("level") or 0) == 2,
              "customer escalates to level 2 through Manage (POST /api/desk/tickets/{id}/escalate)", r.text[:220])
    esc = pg.json_rows(fdb, f"SELECT id, level, status, requested_by_type, requested_by_uuid, ack_due_at, resolve_due_at "
                            f"FROM ticket_escalations WHERE ticket_id = {tid}")
    ctx.check(len(esc) == 1 and esc[0]["requested_by_type"] == "portal" and esc[0]["ack_due_at"] and esc[0]["resolve_due_at"],
              "Flow DB: ticket_escalations row (level 2, requested_by_type portal, statutory due dates)", str(esc))
    ctx.check(pg.scalar(fdb, f"SELECT grievance_level FROM tickets WHERE id = {tid}") == "2"
              and pg.scalar(fdb, f"SELECT status FROM tickets WHERE id = {tid}") == "open",
              "the ticket is re-opened at grievance level 2")
    esc_id = int(esc[0]["id"])
    m_off = f.wait_mail(lambda m: m["to"] == "grievance@aicountly.com" and ref in m["subject"], mark)
    m_ack = f.wait_mail(lambda m: m["to"] == cust["email"] and ref in (m["subject"] + m["html"]), mark)
    ctx.check(m_off is not None and m_off["sender_service"] == "manage", "the Grievance Officer's public mailbox is notified (Manage)",
              m_off["subject"] if m_off else "no mail")
    ctx.check(m_ack is not None, "the customer receives the escalation acknowledgement with the L2 reference",
              m_ack["subject"] if m_ack else "no mail")

    # The officer: a Console user who first holds only desk_operator, then gets grievance_officer.
    admin_console = f.console_superadmin()
    uid = f.console_create_staff(admin_console, *OFFICER)
    f.console_grant(admin_console, uid, "flow", "desk_operator")
    officer_console = f.console_login(OFFICER[1], OFFICER[2])
    op = f.flow_session(officer_console)
    r = client.post(f"{f.FLOW()}/desk/grievances/{esc_id}/acknowledge", bearer=op["token"], json_body={"note": "trying"})
    ctx.check(r.status == 403, "a desk_operator (no officer role) cannot act on a level-2 grievance", f"HTTP {r.status}")

    r = f.console_grant(admin_console, uid, "flow", "grievance_officer")
    ctx.check(r.status == 200, "superadmin grants 'grievance_officer' in Console")
    officer = f.flow_session(officer_console)
    ctx.check("grievance_officer" in (officer.get("user") or {}).get("roles", []),
              "the officer's next Flow sign-in carries the role", str((officer.get("user") or {}).get("roles")))
    tok = officer["token"]

    r = client.get(f"{f.FLOW()}/desk/grievances", bearer=tok, query={"level": 2, "status": "open"})
    items = (((r.json or {}).get("data") or {}).get("items")) or []
    ctx.check(r.status == 200 and any(int(i["id"]) == esc_id for i in items),
              "the officer sees the escalation in Flow's grievance queue", f"{len(items)} item(s)")

    mark = f.mail_mark()
    r = client.post(f"{f.FLOW()}/desk/grievances/{esc_id}/acknowledge", bearer=tok,
                    json_body={"note": "Looking into the HDFC parser with engineering."})
    ctx.check(r.status == 200, "officer acknowledges through Flow (POST /api/desk/grievances/{id}/acknowledge)", f"HTTP {r.status}")
    m = f.wait_mail(lambda m: m["to"] == cust["email"] and "acknowledged" in m["subject"].lower(), mark)
    ctx.check(m is not None, "customer e-mailed the acknowledgement", m["subject"] if m else "no mail")

    mark = f.mail_mark()
    resolution = "Root cause fixed: the HDFC CSV date column is now parsed as DD/MM/YYYY. Re-import works."
    r = client.post(f"{f.FLOW()}/desk/grievances/{esc_id}/resolve", bearer=tok, json_body={"resolution": resolution})
    ctx.check(r.status == 200, "officer resolves through Flow (POST /api/desk/grievances/{id}/resolve)", f"HTTP {r.status}")
    m = f.wait_mail(lambda m: m["to"] == cust["email"] and "resolved" in m["subject"].lower(), mark)
    ctx.check(m is not None and "DD/MM/YYYY" in m["html"], "customer e-mailed the resolution text (and how to go to level 3)",
              m["subject"] if m else "no mail")
    esc = pg.json_rows(fdb, f"SELECT status, acknowledged_at, resolved_at, resolution FROM ticket_escalations WHERE id = {esc_id}")
    ctx.check(esc[0]["status"] == "resolved" and esc[0]["acknowledged_at"] and esc[0]["resolved_at"],
              "Flow DB: escalation acknowledged + resolved", str(esc)[:200])
    acts = [r[0] for r in pg.rows(fdb, f"SELECT action FROM desk_activity_log WHERE entity_type = 'ticket' AND entity_id = {tid}")]
    ctx.check({"grievance.acknowledged", "grievance.resolved"} <= set(acts), "desk_activity_log records the officer's actions", str(sorted(set(acts))))

    time.sleep(0.3)
    r = client.get(f"{f.MANAGE()}/desk/tickets/{tid}", bearer=cust["ses"])
    escs = (((r.json or {}).get("data") or {}).get("escalations")) or []
    ctx.check(r.status == 200 and escs and escs[0].get("status") == "resolved",
              "the customer sees the resolved escalation back in Manage (same Flow DB)", str(escs)[:200])

    log = (services.proc.LOGS / "flow.php.log")
    if log.exists() and "[ConsoleAuditClient]" in log.read_text() and "status=404" in log.read_text():
        ctx.finding("Flow's central-audit fan-out (ConsoleAuditClient -> POST {CONSOLE_API_BASE_URL}/audit) gets 404 "
                    "'Route not found' from Console: Console has no /audit ingest route, so every grievance.* / auth.* "
                    "event Flow believes it sent to Console's central audit is lost (Flow's local audit_logs still has them).")
