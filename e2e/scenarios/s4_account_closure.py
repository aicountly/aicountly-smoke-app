"""4. Account closure: a customer who owns a company (created in Manage, with Smart Books data) closes
the account on my.aicountly; time is moved past day 45 (DB timestamp); the portal's daily purge
asks Manage to purge; Manage's outbox delivers a signed company_purge_requested to Books; Books'
worker archives then deletes the company's rows and acks; Manage hard-deletes the company and leaves
a tombstone. Asserts the state in all three databases."""

from harness import client, config, pg, proc, services
from harness import fixtures as f

ID = "4"
TITLE = "Account closure -> portal purge -> Manage purge -> signed event -> Books archive+purge+ack -> Manage hard delete"
SYSTEMS = "my.aicountly, Manage, Smart Books, e-mail"

UUID = 2004


def manage_cli(args):
    return proc.php_cli("manage", services.load_env("manage"), config.src("manage") / "server-php", args)


def run(ctx):
    f.require("portal", "manage", "books", "mail")
    pdb, mdb, bdb = config.db("portal"), config.db("manage"), config.db("books")
    k = services.keys()

    cust = f.customer("arjun", UUID, "Arjun", "Mehta", "arjun.mehta@example.test", "9845002004")
    cid = f.manage_create_company(cust["ses"], "Mehta Exports Private Limited", "accounts@mehta-exports.example.test")
    ctx.check(cid > 0, "customer creates a company through Manage (POST /api/companies/create)", f"cmp_id {cid}")
    fy = pg.scalar(mdb, f"SELECT fy_id FROM ghm_fy WHERE cmp_id = {cid} ORDER BY fy_id LIMIT 1")
    q = {"cmp_id": cid, "fy_id": fy, "bo_id": 0}
    r = client.get(f"{f.BOOKS()}/access/me", bearer=cust["ses"], query=q, timeout=180)
    ctx.check(r.status == 200, "Books opens the company for its owner (portal session + Manage companyinfo; masters bootstrapped)", f"HTTP {r.status}")
    parent = pg.scalar(bdb, f"SELECT acc_grp_id FROM books_account_groups WHERE cmp_id = {cid} AND grp_name ILIKE 'Sundry Debtors' LIMIT 1")
    r = client.post(f"{f.BOOKS()}/masters/account-groups", bearer=cust["ses"], query=q,
                    json_body={"grp_name": "Export Debtors", "parent_grp_id": parent})
    ctx.check(r.status == 201, "customer writes data in Books", f"HTTP {r.status}")
    books_rows = int(pg.scalar(bdb, f"SELECT count(*) FROM books_account_groups WHERE cmp_id = {cid}") or 0)
    ctx.step("Books rows for the company before closure (books_account_groups)", str(books_rows))

    r = client.get(f"{f.PORTAL()}/auth/account/closure-summary", bearer=cust["auth"])
    d = (r.json or {}).get("data") or {}
    owned = [c.get("cmp_id") for c in d.get("owned_companies", [])]
    ctx.check(r.status == 200 and d.get("manage_companies_available") is True and cid in owned,
              "closure summary lists the Manage-owned company (portal -> Manage internal/account-closure/companies)",
              f"owned={owned} manage_companies_available={d.get('manage_companies_available')}")
    ctx.check((d.get("timeline") or {}).get("purge_after_days") == 45, "30/45-day policy applies", str(d.get("timeline")))

    # The deletion gate reads the same merged list: an owner whose only company is in Manage (none in
    # the portal's legacy cmpacsmstr) is refused without confirm_company_loss.
    legacy = pg.scalar(pdb, f"SELECT count(*) FROM cmpacsmstr WHERE uuid_aictly_by = '{UUID}' AND uuid_acs_type = 1")
    ctx.check(legacy == "0", "the owner holds no company in the portal's legacy store (Manage-only owner)", f"legacy owned rows={legacy}")
    r = client.post(f"{f.PORTAL()}/auth/account/delete", bearer=cust["auth"],
                    json_body={"confirm": "DELETE", "reason": "e2e: moving to another tool"})
    j = r.json or {}
    gate_ids = [c.get("cmp_id") for c in j.get("owned_companies") or []]
    ctx.check(r.status == 409 and gate_ids == [cid] and not j.get("companies_unavailable"),
              "delete without confirm_company_loss: 409 listing the Manage company (gate reads Manage, not only the legacy store)",
              f"HTTP {r.status} {r.text[:200]}")
    ctx.check(pg.scalar(pdb, f"SELECT useraictly_status FROM useraictly WHERE uuid = {UUID}") == "1",
              "the refused request changed nothing (account still active)")

    mark = f.mail_mark()
    r = client.post(f"{f.PORTAL()}/auth/account/delete", bearer=cust["auth"],
                    json_body={"confirm": "DELETE", "confirm_company_loss": True, "reason": "e2e: moving to another tool"})
    j = r.json or {}
    ctx.check(r.status == 200 and j.get("policy") == "standard_30_45" and j.get("phase") == "cooling_off",
              "with confirm_company_loss the customer closes the account (POST /api/auth/account/delete)", r.text[:200])
    ctx.check(pg.scalar(pdb, f"SELECT useraictly_status FROM useraictly WHERE uuid = {UUID}") == "6", "portal: status 6 (pending deletion)")
    m = f.wait_mail(lambda m: m["to"] == cust["email"], mark, timeout=10)
    ctx.soft(m is not None and m["sender_service"] == "portal", "portal e-mails the closure notice", m["subject"] if m else "no mail")
    r = client.post(f"{f.PORTAL()}/validatesession", bearer=cust["ses"])
    ctx.check(r.status != 200 or (r.json or {}).get("status") != 1, "the customer's existing session is revoked at closure", f"HTTP {r.status}")

    # Simulated time: day 46.
    pg.run_sql(pdb, f"UPDATE useraictly SET useraictly_deletion_requested_at = useraictly_deletion_requested_at - INTERVAL '46 days' WHERE uuid = {UUID}")
    ctx.step("time moved: deletion requested 46 days ago (DB timestamp)")
    p = services.portal_cli(["accounts:purge-expired-deletions", "--dry-run"])
    ctx.check(str(UUID) in p.stdout.decode(), "portal dry run lists the account as due", p.stdout.decode().strip()[-160:])
    p = services.portal_cli(["accounts:purge-expired-deletions"])
    out = p.stdout.decode()
    ctx.check("Permanently deleted 1 account" in out, "portal purge sweep (php spark accounts:purge-expired-deletions) finalises", out.strip()[-200:])
    ctx.check(pg.scalar(pdb, f"SELECT count(*) FROM useraictly WHERE uuid = {UUID}") == "0", "portal: the person row is gone")

    purge = pg.json_rows(mdb, f"SELECT id, status, reason, requested_by, apps FROM ghm_company_purge WHERE cmp_id = {cid}")
    ctx.check(len(purge) == 1 and purge[0]["reason"] == "account_closed" and purge[0]["requested_by"] == f"account_closure:{UUID}"
              and purge[0]["apps"].get("books", {}).get("status") == "requested",
              "Manage accepted POST internal/account-closure/purge: whole-company purge, books asked", str(purge)[:300])
    r = client.get(f"{f.MANAGE()}/internal/account-closure/purge", bearer=k["manage_purge"], query={"uuid": UUID})
    ctx.check(r.status == 200, "Manage reports the closure purge to the portal key (GET internal/account-closure/purge)", f"HTTP {r.status}")

    p = manage_cli(["scripts/product_events.php", "--deliver"])
    ev = pg.json_rows(mdb, f"SELECT status, last_http_status FROM ghm_product_event_outbox "
                           f"WHERE cmp_id = {cid} AND app_key = 'books' AND event = 'company_purge_requested'")
    ctx.check(len(ev) == 1 and ev[0]["status"] in ("delivered", "acked") and ev[0]["last_http_status"] == 202,
              "Manage outbox delivers the signed company_purge_requested to Books (Books answered 202)",
              f"{ev} {p.stdout.decode().strip()[:160]}")
    st = pg.json_rows(bdb, f"SELECT state, reason FROM books_company_lifecycle WHERE company_id = {cid}")
    job = pg.json_rows(bdb, f"SELECT status FROM books_lifecycle_purge_jobs WHERE company_id = {cid}")
    ctx.check(st and st[0]["state"] == "purge_pending" and st[0]["reason"] == "account_closed" and job and job[0]["status"] == "pending",
              "Books verified the HMAC, stored the event, company purge_pending, job queued (nothing deleted in the request)", f"{st} {job}")
    ctx.check(int(pg.scalar(bdb, f"SELECT count(*) FROM books_account_groups WHERE cmp_id = {cid}") or 0) == books_rows,
              "Books data untouched until the worker runs")

    has_account_events = pg.scalar(mdb, "SELECT count(*) FROM information_schema.columns "
                                         "WHERE table_name = 'ghm_product_event_outbox' AND column_name = 'uuid'") == "1"
    if has_account_events:
        acc = pg.json_rows(mdb, f"SELECT status, last_http_status, last_error FROM ghm_product_event_outbox "
                                f"WHERE event = 'account_purge_requested' AND uuid = '{UUID}' AND app_key = 'books'")
        ctx.check(len(acc) == 1 and acc[0]["status"] in ("delivered", "acked") and acc[0]["last_http_status"] == 202,
                  "Manage also delivers the per-person account_purge_requested to Books (202)", str(acc))
    else:
        ctx.step("this Manage checkout sends no per-person account_purge_requested (before migration 020)")
    p = services.books_cli(["books:company-lifecycle-worker", "--jobs=5", "--acks=50"])
    out = p.stdout.decode()
    ctx.check(p.returncode == 0 and "purged" in out, "Books worker (spark books:company-lifecycle-worker) runs the purge and the acks",
              out.strip()[-260:])
    job = pg.json_rows(bdb, f"SELECT status, archive_schema, rows_purged, retained_json, ack_status, ack_last_http "
                            f"FROM books_lifecycle_purge_jobs WHERE company_id = {cid}")[0]
    ctx.check(job["status"] == "purged" and job["ack_status"] == "sent" and job["ack_last_http"] == 200,
              "Books job: purged, ack answered 200", str(job)[:300])
    archived = int(pg.scalar(bdb, f'SELECT count(*) FROM "{job["archive_schema"]}".books_account_groups WHERE cmp_id = {cid}') or 0)
    left = int(pg.scalar(bdb, f"SELECT count(*) FROM books_account_groups WHERE cmp_id = {cid}") or 0)
    ctx.check(archived == books_rows and left == 0, "archive-first: every account-group row is in the archive schema and none left live",
              f"archived={archived} live={left} schema={job['archive_schema']}")

    if has_account_events:
        clo = pg.json_rows(mdb, f"SELECT apps, apps_status FROM ghm_account_closure WHERE uuid = '{UUID}'")
        books_ans = ((clo[0]["apps"] or {}).get("books") or {}) if clo else {}
        ctx.check(clo and books_ans.get("status") in ("purged", "nothing_to_purge") and clo[0]["apps_status"] == "completed",
                  "Manage recorded Books' answer to the account purge (ghm_account_closure.apps, completed)", str(clo)[:300])

    purge = pg.json_rows(mdb, f"SELECT status, completed_at, apps FROM ghm_company_purge WHERE cmp_id = {cid}")[0]
    ctx.check(purge["status"] == "completed" and purge["apps"]["books"]["status"] == "purged",
              "Manage: purge completed on Books' ack", str(purge)[:200])
    ctx.check(pg.scalar(mdb, f"SELECT count(*) FROM ghm_company WHERE cmp_id = {cid}") == "0", "Manage: company hard-deleted")
    tomb = pg.json_rows(mdb, f"SELECT * FROM ghm_company_deleted WHERE cmp_id = {cid}")
    ctx.check(len(tomb) == 1 and "account_closed" in str(tomb[0]), "Manage: tombstone row (lifecycle:account_closed)", str(tomb)[:300])
    r = client.get(f"{f.MANAGE()}/internal/company-status", bearer=k["manage_books_key"], query={"ids": cid})
    ctx.check(r.status == 200 and "deleted" in r.text, "products see the company as deleted (GET internal/company-status)", r.text[:200])
