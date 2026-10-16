"""9. Account closure reaches Flow: a customer with support records in Flow (a ticket raised through
Manage's Help & Support, an e-mail to support@) closes the account; the portal's day-46 sweep asks Manage
to purge; Manage's outbox delivers the signed account_purge_requested to Flow (a lifecycle-only app:
LIFECYCLE_WEBHOOK_SECRET_FLOW + LIFECYCLE_WEBHOOK_URL_FLOW); Flow's lifecycle worker (kit 1.1.1 through
config/lifecycle-kit.php) deletes nothing but MARKS every record of that customer for anonymisation
three years on (archived first) and acks `purged` with the tables it retains and why; Manage records
Flow's answer on the account closure."""

import email.utils
import json
from email.message import EmailMessage

from harness import client, config, pg, proc, services
from harness import fixtures as f

ID = "9"
TITLE = "Account closure -> Manage -> Flow account_purge_requested -> support records marked for anonymisation -> ack purged + retained"
SYSTEMS = "my.aicountly, Manage, Flow (kit 1.1.1 receiver + worker), Smart Books, e-mail"

UUID = 2009
MARKED = ("tickets", "desk_inbound_emails", "desk_activity_log")


def run(ctx):
    f.require("portal", "manage", "flow", "books", "mail")
    mdb, fdb = config.db("manage"), config.db("flow")

    cust = f.customer("neha", UUID, "Neha", "Joshi", "neha.joshi@example.test", "9845002009")
    t = f.manage_desk_ticket(cust["ses"], "GST return export is empty", "The GSTR-1 export downloads an empty file for September.")
    tid = int(t["ticket_id"])
    ctx.check(pg.scalar(fdb, f"SELECT portal_uuid FROM tickets WHERE id = {tid}") == str(UUID),
              "customer raises a ticket through Manage Help & Support (a row in the Flow DB)", f"ticket #{tid}")

    m = EmailMessage()
    m["From"] = f"Neha Joshi <{cust['email']}>"
    m["To"] = "support@aicountly.com"
    m["Subject"] = "Invoice copy for September"
    m["Message-ID"] = email.utils.make_msgid(domain="example.test")
    m["Date"] = email.utils.formatdate()
    m.set_content("Please send me a copy of the September invoice. Phone 9845002009.")
    p = proc.php_cli("flow-inbound", services.load_env("flow"), config.src("flow") / "server-php",
                     ["scripts/inbound_email_pipe.php"], stdin=m.as_bytes(), check=False)
    mid = m["Message-ID"].strip("<>")
    inbound = pg.json_rows(fdb, f"SELECT id, ticket_id, from_email FROM desk_inbound_emails WHERE message_id = '{mid}'")
    ctx.check(p.returncode == 0 and len(inbound) == 1, "the customer's e-mail to support@ becomes a Flow ticket (inbound pipe)", str(inbound))
    before = {tb: int(pg.scalar(fdb, f"SELECT count(*) FROM {tb}") or 0) for tb in MARKED}

    f.close_account_and_purge(ctx, cust, UUID)

    clo = pg.json_rows(mdb, f"SELECT apps, apps_status FROM ghm_account_closure WHERE uuid = '{UUID}'")
    apps = (clo[0]["apps"] or {}) if clo else {}
    ctx.check(clo and "flow" in apps and apps["flow"].get("status") == "requested",
              "Manage's account closure asks Flow (lifecycle-only app) as well as the integrated products", str(apps)[:300])

    p = f.manage_cli(["scripts/product_events.php", "--deliver"])
    ev = pg.json_rows(mdb, "SELECT event_id::text AS event_id, status, last_http_status, last_error FROM ghm_product_event_outbox "
                           f"WHERE event = 'account_purge_requested' AND uuid = '{UUID}' AND app_key = 'flow'")
    ctx.check(len(ev) == 1 and ev[0]["status"] in ("delivered", "acked") and ev[0]["last_http_status"] == 202,
              "Manage's outbox delivers the signed account_purge_requested to Flow (Flow answered 202)",
              f"{ev} {p.stdout.decode().strip()[:160]}")
    ctx.check(pg.scalar(mdb, "SELECT count(*) FROM ghm_product_event_outbox WHERE app_key = 'flow' AND event <> 'account_purge_requested'") == "0",
              "Flow is sent account events only (no company events: LIFECYCLE_EXTRA_APPS 'flow')")
    job = pg.json_rows(fdb, f"SELECT event_id::text AS event_id, status FROM aic_lifecycle_jobs WHERE kind = 'account' AND target_uuid = '{UUID}'")
    ctx.check(len(job) == 1 and job[0]["event_id"] == ev[0]["event_id"] and job[0]["status"] == "pending",
              "Flow verified the HMAC and queued the account job (nothing marked inside the request)", str(job))
    ctx.check(pg.scalar(fdb, f"SELECT count(*) FROM tickets WHERE portal_uuid = '{UUID}' AND anonymise_after IS NOT NULL") == "0",
              "nothing is marked until the worker runs")

    services.books_cli(["books:company-lifecycle-worker", "--jobs=5", "--acks=50"])
    p, out = f.flow_lifecycle_worker()
    ctx.check(p.returncode == 0 and out is not None, "Flow's cron worker (kit bin/worker.php --bootstrap=config/lifecycle-kit.php) runs",
              json.dumps(out)[:300] if out else p.stderr.decode()[-300:])

    job = pg.json_rows(fdb, "SELECT status, rows_purged, retained, detail, archive_name FROM aic_lifecycle_jobs "
                            f"WHERE kind = 'account' AND target_uuid = '{UUID}'")[0]
    ctx.check(job["status"] == "purged" and int(job["rows_purged"]) == 0 and "anonymised on" in (job["detail"] or ""),
              "Flow job: purged with nothing deleted — the records are kept and marked (detail names the anonymisation date)",
              str(job)[:300])
    retained_tables = sorted({(r.get("table") if isinstance(r, dict) else str(r)) for r in (job["retained"] or [])})
    ctx.check({"public.tickets", "public.desk_inbound_emails"} <= set(retained_tables) or {"tickets", "desk_inbound_emails"} <= set(retained_tables),
              "the retained list names the ticket and inbound-mail tables", str(retained_tables)[:300])

    sched = pg.json_rows(fdb, "SELECT status, round(extract(epoch FROM anonymise_after - requested_at) / 86400) AS gap_days, marked "
                              f"FROM flow_customer_anonymisation WHERE subject_uuid = '{UUID}'")
    ctx.check(bool(sched) and sched[0]["status"] == "scheduled" and 1094 <= float(sched[0]["gap_days"]) <= 1097,
              "flow_customer_anonymisation: scheduled 3 years after the request", str(sched)[:300])
    rows = pg.json_rows(fdb, "SELECT id, portal_email, anonymise_after IS NOT NULL AS marked, retention_subject_uuid, retention_from IS NOT NULL AS has_from "
                             f"FROM tickets WHERE portal_uuid = '{UUID}' OR id = {inbound[0]['ticket_id'] or 0} ORDER BY id")
    ctx.check(len(rows) >= 2 and all(r["marked"] and r["retention_subject_uuid"] == str(UUID) and r["has_from"] for r in rows),
              "both tickets (the Manage one and the e-mailed one) carry anonymise_after, retention_from and retention_subject_uuid", str(rows)[:300])
    em = pg.json_rows(fdb, f"SELECT anonymise_subject_uuid, from_email FROM desk_inbound_emails WHERE message_id = '{mid}'")
    ctx.check(em and em[0]["anonymise_subject_uuid"] == str(UUID),
              "the inbound e-mail (tied to the account only by address) is marked for the same customer", str(em))
    ctx.check(all(r["portal_email"] == cust["email"] for r in rows) and em[0]["from_email"] == cust["email"],
              "nothing is anonymised yet (identifiers kept until the 3-year date)")
    after = {tb: int(pg.scalar(fdb, f"SELECT count(*) FROM {tb}") or 0) for tb in MARKED}
    ctx.check(after == before, "nothing deleted in Flow", f"before={before} after={after}")
    arch = job["archive_name"]
    n_arch = int(pg.scalar(fdb, f"SELECT count(*) FROM information_schema.tables WHERE table_schema = '{arch}'") or 0) if arch else 0
    ctx.check(n_arch > 0, "archive-first: the marking is archived into the kit's archive schema (restorable)", f"{arch}: {n_arch} table(s)")

    acks = pg.json_rows(fdb, f"SELECT status, last_http, body FROM aic_lifecycle_acks WHERE event_id = '{ev[0]['event_id']}'")
    ack_body = json.loads(acks[0]["body"]) if acks else {}
    ctx.check(len(acks) == 1 and acks[0]["status"] == "sent" and acks[0]["last_http"] == 200 and ack_body.get("status") == "purged",
              "Flow's signed ack (POST Manage internal/company-lifecycle/ack, X-Product-App flow) answered 200",
              f"{[{k: v for k, v in a.items() if k != 'body'} for a in acks]} body.status={ack_body.get('status')}")

    clo = pg.json_rows(mdb, f"SELECT apps, apps_status FROM ghm_account_closure WHERE uuid = '{UUID}'")[0]
    fa = (clo["apps"] or {}).get("flow") or {}
    ctx.check(fa.get("status") == "purged" and fa.get("event_id") == ev[0]["event_id"],
              "Manage recorded Flow's ack on the account closure: purged", str(fa)[:300])
    ctx.check(isinstance(fa.get("retained"), list) and any("tickets" in str(x) for x in fa["retained"]) and "anonymised on" in str(fa.get("detail")),
              "  with the retained tables and the reason (kept, anonymised on the date, deleted after 8 years)", str(fa)[:400])
    ctx.check(clo["apps_status"] == "completed", "Manage: every app answered — the account purge is completed", str(clo["apps_status"]))
    r = client.get(f"{f.MANAGE()}/internal/account-closure/purge", bearer=services.keys()["manage_purge"], query={"uuid": UUID})
    ctx.check(r.status == 200 and "flow" in r.text, "Manage reports Flow's answer to the portal key (GET internal/account-closure/purge)", r.text[:240])

    p, out = f.flow_lifecycle_worker()
    ctx.check(pg.scalar(fdb, f"SELECT count(*) FROM aic_lifecycle_jobs WHERE kind = 'account' AND target_uuid = '{UUID}'") == "1",
              "a second worker run does nothing more (one job, idempotent)")
