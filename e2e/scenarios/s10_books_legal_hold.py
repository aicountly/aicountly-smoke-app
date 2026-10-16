"""10. A legal hold in Smart Books stops a purge Manage asked for, and lifting it lets the purge finish: an
operator places a hold on the company in Books (`spark books:legal-hold`, a tax notice in hand); the
company's Books subscription lapses and its 45-day window passes (DB timestamps); Manage's daily job
requests the purge and delivers the signed company_purge_requested; Books' worker touches nothing, keeps
the job `held` and acks Manage `held` with the reason (once); Manage marks the purge blocked with
`legal_hold: books — <reason>` and alerts ops once; the hold is lifted; the next look purges (archive
first) and acks `purged`; Manage completes the purge."""

import re

from harness import client, config, pg, services
from harness import fixtures as f

ID = "10"
TITLE = "Books legal hold: purge requested -> Books acks held -> Manage purge blocked (legal_hold) -> hold lifted -> purged -> completed"
SYSTEMS = "Manage, Smart Books, my.aicountly, e-mail"

REASON = "Notice u/s 148 Income-tax Act, 12 Oct 2026 (ticket LH-e2e-7)"


def run(ctx):
    f.require("portal", "manage", "books", "mail")
    mdb, bdb = config.db("manage"), config.db("books")
    k = services.keys()

    cust = f.customer("vivek", 2010, "Vivek", "Nair", "vivek.nair@example.test", "9845002010")
    cid = f.manage_create_company(cust["ses"], "Nair Agro Foods Private Limited", "accounts@nair-agro.example.test")
    fy = pg.scalar(mdb, f"SELECT fy_id FROM ghm_fy WHERE cmp_id = {cid} ORDER BY fy_id LIMIT 1")
    q = {"cmp_id": cid, "fy_id": fy, "bo_id": 0}
    r = client.get(f"{f.BOOKS()}/access/me", bearer=cust["ses"], query=q, timeout=180)
    ctx.check(r.status == 200, "owner opens the company in Books", f"cmp_id {cid}, HTTP {r.status}")
    rows_before = int(pg.scalar(bdb, f"SELECT count(*) FROM books_account_groups WHERE cmp_id = {cid}") or 0)

    p = services.books_cli(["books:legal-hold", f"--company={cid}", f"--reason={REASON}", "--by=compliance@aicountly.example"])
    hold_id = pg.scalar(bdb, f"SELECT id FROM books_legal_holds WHERE company_id = {cid} AND lifted_at IS NULL")
    ctx.check(p.returncode == 0 and hold_id, "operator places a legal hold on the company in Books (spark books:legal-hold)",
              p.stdout.decode().strip()[-160:])

    sub = {"cmp_id": cid, "app_key": "books", "kind": "paid", "status": "cancelled",
           "current_period_end": "2026-10-01T00:00:00Z", "source": "manual", "notify_email": cust["email"]}
    r = client.post(f"{f.MANAGE()}/internal/subscriptions", bearer=k["manage_console_key"], json_body=sub)
    ctx.check(r.status == 200, "operator records a lapsed paid Books subscription (POST internal/subscriptions)", r.text[:160])
    f.manage_cli(["scripts/company_lifecycle.php", "--apply"])
    st = pg.json_rows(mdb, f"SELECT status FROM ghm_subscription WHERE cmp_id = {cid} AND app_key = 'books'")
    ctx.check(st and st[0]["status"] == "restricted", "Manage's daily job restricts it (45-day window)", str(st))

    pg.run_sql(mdb, f"UPDATE ghm_subscription SET restricted_from = restricted_from - INTERVAL '46 days', "
                    f"restricted_until = now() - INTERVAL '1 day' WHERE cmp_id = {cid} AND app_key = 'books'")
    ctx.step("time moved: the 45-day window ended yesterday (ghm_subscription.restricted_until)")
    p = f.manage_cli(["scripts/company_lifecycle.php", "--apply"])
    out = p.stdout.decode()
    purge = pg.json_rows(mdb, f"SELECT id, status, reason, apps FROM ghm_company_purge WHERE cmp_id = {cid}")
    ctx.check(purge and purge[0]["apps"].get("books", {}).get("status") in ("requested", "delivered"),
              "Manage's daily job requests the purge of the company's Books data (company_purge_requested)", str(purge)[:300])
    purge_id = purge[0]["id"]
    f.manage_cli(["scripts/product_events.php", "--deliver"])
    ev = pg.json_rows(mdb, f"SELECT event_id::text AS event_id, status, last_http_status FROM ghm_product_event_outbox "
                           f"WHERE cmp_id = {cid} AND app_key = 'books' AND event = 'company_purge_requested'")
    ctx.check(ev and ev[0]["status"] in ("delivered", "acked") and ev[0]["last_http_status"] == 202,
              "Manage's outbox delivered the signed event to Books (202)", str(ev))

    mark = f.mail_mark()
    p = services.books_cli(["books:company-lifecycle-worker", "--jobs=5", "--acks=50"])
    job = pg.json_rows(bdb, f"SELECT id, status, hold_reason, rows_purged, ack_status, ack_last_http, ack_sent_status FROM books_lifecycle_purge_jobs "
                            f"WHERE company_id = {cid}")
    ctx.check(job and job[0]["status"] == "held" and REASON in (job[0]["hold_reason"] or ""),
              "Books' worker finds the hold: job held, nothing touched", f"{job} {p.stdout.decode().strip()[-200:]}")
    ctx.check(int(pg.scalar(bdb, f"SELECT count(*) FROM books_account_groups WHERE cmp_id = {cid}") or 0) == rows_before,
              "Books data untouched under the hold", f"rows={rows_before}")
    ctx.check(job[0]["ack_status"] == "sent" and job[0]["ack_last_http"] == 200 and job[0]["ack_sent_status"] == "held",
              "Books acked Manage `held` (signed ack, 200)", str(job[0]))
    aud = pg.scalar(bdb, f"SELECT count(*) FROM books_audit_log WHERE action = 'company.lifecycle_purge.held'") \
        if pg.scalar(bdb, "SELECT count(*) FROM information_schema.columns WHERE table_name = 'books_audit_log' AND column_name = 'action'") == "1" else None
    ctx.step("Books audit trail: company.lifecycle_purge.held rows", str(aud))

    purge = pg.json_rows(mdb, f"SELECT status, blocked_reason, apps FROM ghm_company_purge WHERE id = {purge_id}")[0]
    ctx.check(purge["status"] == "blocked" and (purge["blocked_reason"] or "").startswith("legal_hold: books") and REASON in purge["blocked_reason"],
              "Manage: purge blocked — blocked_reason 'legal_hold: books — <reason>'", f"{purge['status']}: {purge['blocked_reason']}")
    ctx.check(purge["apps"]["books"]["status"] == "held", "Manage: Books' answer recorded as held", str(purge["apps"])[:200])
    f.manage_cli(["scripts/product_events.php", "--deliver"])
    m = f.wait_mail(lambda m: m["to"] == "ops-alerts@aicountly.example" and "legal hold" in m["subject"].lower(), mark, timeout=10)
    ctx.check(m is not None and m["sender_service"] == "manage", "Manage alerts ops once: 'Company purge blocked (legal hold)'",
              m["subject"] if m else "no alert mail")
    f.manage_cli(["scripts/product_events.php", "--deliver"])
    n_alerts = len([x for x in f.mail_since(mark) if x["to"] == "ops-alerts@aicountly.example" and "legal hold" in x["subject"].lower()])
    ctx.check(n_alerts == 1, "  and only once (a later run does not repeat it)", f"{n_alerts} alert(s)")

    # The daily re-look while still held: nothing sent again.
    pg.run_sql(bdb, f"UPDATE books_lifecycle_purge_jobs SET next_attempt_at = now() WHERE company_id = {cid}")
    p = services.books_cli(["books:company-lifecycle-worker", "--jobs=5", "--acks=50"])
    job2 = pg.json_rows(bdb, f"SELECT status, ack_sent_status, ack_attempts FROM books_lifecycle_purge_jobs WHERE company_id = {cid}")[0]
    ctx.check(job2["status"] == "held" and "still held" in p.stdout.decode(),
              "the worker's next look while the hold is open: still held, Manage not told again", f"{job2} {p.stdout.decode().strip()[-120:]}")

    p = services.books_cli(["books:legal-hold", f"--lift={hold_id}", "--by=compliance@aicountly.example", "--note=Assessment closed"])
    ctx.check(p.returncode == 0 and pg.scalar(bdb, f"SELECT lifted_at IS NOT NULL FROM books_legal_holds WHERE id = {hold_id}") == "t",
              "operator lifts the hold (spark books:legal-hold --lift)", p.stdout.decode().strip()[-160:])
    pg.run_sql(bdb, f"UPDATE books_lifecycle_purge_jobs SET next_attempt_at = now() WHERE status = 'held' AND company_id = {cid}")
    ctx.step("the held job is made due now (as the lift command says; otherwise the daily re-look)")
    p = services.books_cli(["books:company-lifecycle-worker", "--jobs=5", "--acks=50"])
    job = pg.json_rows(bdb, f"SELECT status, archive_schema, rows_purged, ack_status, ack_last_http, ack_sent_status FROM books_lifecycle_purge_jobs "
                            f"WHERE company_id = {cid}")[0]
    ctx.check(job["status"] == "purged" and job["ack_status"] == "sent" and job["ack_last_http"] == 200 and job["ack_sent_status"] == "purged",
              "Books purges on the next look and acks `purged` (200)", str(job)[:300])
    arch = job["archive_schema"] or ""
    archived = int(pg.scalar(bdb, f'SELECT count(*) FROM "{arch}".books_account_groups WHERE cmp_id = {cid}') or 0) if re.fullmatch(r"[a-z0-9_]+", arch) else -1
    left = int(pg.scalar(bdb, f"SELECT count(*) FROM books_account_groups WHERE cmp_id = {cid}") or 0)
    ctx.check(archived == rows_before and left == 0, "archive-first: every account group archived, none left live", f"archived={archived} live={left} {arch}")

    purge = pg.json_rows(mdb, f"SELECT status, blocked_reason, completed_at, apps FROM ghm_company_purge WHERE id = {purge_id}")[0]
    ctx.check(purge["status"] == "completed" and purge["apps"]["books"]["status"] == "purged" and purge["completed_at"],
              "Manage: the blocked purge completes on Books' purged ack (held is not final)", str(purge)[:300])
    sub = pg.json_rows(mdb, f"SELECT status FROM ghm_subscription WHERE cmp_id = {cid} AND app_key = 'books'")
    ctx.step("Manage subscription state after the purge", str(sub))
    st = pg.json_rows(bdb, f"SELECT state FROM books_company_lifecycle WHERE company_id = {cid}")
    ctx.check(st and st[0]["state"] == "purged", "Books: company state purged", str(st))
