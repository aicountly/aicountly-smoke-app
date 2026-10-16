"""5. Subscription lapse: an operator (Manage service key labelled console) records a cancelled paid
Smart Books subscription whose period already ended; Manage's daily lifecycle job restricts the company
and its outbox delivers a signed company_restricted to Books; Books then answers 423 to writes while
reads keep working; a renewal lifts it (company_unrestricted) and writes work again."""

from harness import client, config, pg, proc, services
from harness import fixtures as f

ID = "5"
TITLE = "Subscription lapse -> lifecycle job -> company_restricted -> Books 423 on writes, GET ok -> renewal -> unrestricted"
SYSTEMS = "Manage, Smart Books, my.aicountly, e-mail"


def manage_cli(args):
    return proc.php_cli("manage", services.load_env("manage"), config.src("manage") / "server-php", args)


def run(ctx):
    f.require("portal", "manage", "books", "mail")
    mdb, bdb = config.db("manage"), config.db("books")
    k = services.keys()

    cust = f.customer("sana", 2005, "Sana", "Kapoor", "sana.kapoor@example.test", "9845002005")
    cid = f.manage_create_company(cust["ses"], "Kapoor Textiles Private Limited", "accounts@kapoor-textiles.example.test")
    fy = pg.scalar(mdb, f"SELECT fy_id FROM ghm_fy WHERE cmp_id = {cid} ORDER BY fy_id LIMIT 1")
    q = {"cmp_id": cid, "fy_id": fy, "bo_id": 0}
    r = client.get(f"{f.BOOKS()}/access/me", bearer=cust["ses"], query=q, timeout=180)
    ctx.check(r.status == 200, "owner opens the company in Books", f"cmp_id {cid}, HTTP {r.status}")
    parent = pg.scalar(bdb, f"SELECT acc_grp_id FROM books_account_groups WHERE cmp_id = {cid} AND grp_name ILIKE 'Sundry Debtors' LIMIT 1")

    def write(name):
        return client.post(f"{f.BOOKS()}/masters/account-groups", bearer=cust["ses"], query=q,
                           json_body={"grp_name": name, "parent_grp_id": parent})

    ctx.check(write("Retail Debtors North").status == 201, "a write works while the subscription is active")

    sub = {"cmp_id": cid, "app_key": "books", "kind": "paid", "status": "active",
           "current_period_end": "2026-12-31T23:59:59Z", "source": "manual", "notify_email": cust["email"]}
    r = client.post(f"{f.MANAGE()}/internal/subscriptions", bearer=k["manage_console_key"], json_body=sub)
    ctx.check(r.status == 200, "operator records an active paid Books subscription (POST internal/subscriptions, console-labelled key)", r.text[:160])
    r = client.post(f"{f.MANAGE()}/internal/subscriptions", bearer=k["manage_books_key"],
                    json_body=sub | {"status": "cancelled", "current_period_end": "2026-10-01T00:00:00Z"})
    ctx.check(r.status == 403, "a product's own key may not write subscriptions (Books key refused)", f"HTTP {r.status}")
    r = client.post(f"{f.MANAGE()}/internal/subscriptions", bearer=k["manage_console_key"],
                    json_body={"cmp_id": cid, "app_key": "books", "status": "cancelled",
                               "current_period_end": "2026-10-10T00:00:00Z", "source": "manual"})
    ctx.check(r.status == 200 and ((r.json or {}).get("data") or {}).get("subscription", {}).get("status") == "cancelled",
              "operator cancels it with the period end already past", r.text[:160])

    mark = f.mail_mark()
    p = manage_cli(["scripts/company_lifecycle.php", "--apply"])
    out = p.stdout.decode()
    ctx.check('"restricted": [' in out and f'"cmp_id": {cid}' in out, "Manage daily job (scripts/company_lifecycle.php --apply) restricts the company",
              out[:300].replace("\n", " "))
    sub_row = pg.json_rows(mdb, f"SELECT status, restricted_from, restricted_until FROM ghm_subscription WHERE cmp_id = {cid} AND app_key = 'books'")
    ctx.check(sub_row and sub_row[0]["status"] == "restricted" and sub_row[0]["restricted_until"],
              "Manage: subscription restricted, restricted_until set (45-day window)", str(sub_row))
    m = f.wait_mail(lambda m: m["to"] == cust["email"] and "view-only" in m["subject"], mark)
    ctx.check(m is not None and m["sender_service"] == "manage", "owner e-mailed the restricted notice with the deletion date",
              m["subject"] if m else "no mail")
    manage_cli(["scripts/product_events.php", "--deliver"])
    ev = pg.json_rows(mdb, f"SELECT event, status FROM ghm_product_event_outbox WHERE cmp_id = {cid} ORDER BY id")
    ctx.check(any(e["event"] == "company_restricted" and e["status"] in ("delivered", "acked") for e in ev),
              "Manage outbox: company_restricted delivered to Books (signed HMAC POST)", str(ev))
    st = pg.json_rows(bdb, f"SELECT state, source, reason FROM books_company_lifecycle WHERE company_id = {cid}")
    ctx.check(st and st[0]["state"] == "restricted", "Books stored the restriction", str(st))

    r = client.get(f"{f.MANAGE()}/companyinfo", bearer=cust["ses"], query={"comp_id": cid, "app": "books"})
    life = ((r.json or {}).get("data") or {}).get("lifecycle")
    ctx.check(r.status == 200 and life == "restricted", "Manage companyinfo?app=books says restricted (HTTP 200, not 403)", f"lifecycle={life}")

    r = write("Retail Debtors South")
    j = r.json or {}
    ctx.check(r.status == 423 and j.get("code") == "COMPANY_RESTRICTED", "Books refuses a write with 423 COMPANY_RESTRICTED",
              r.text[:220])
    r = client.get(f"{f.BOOKS()}/masters/account-groups", bearer=cust["ses"], query=q)
    ctx.check(r.status == 200 and "Retail Debtors North" in r.text, "Books still serves reads (GET masters/account-groups 200)", f"HTTP {r.status}")

    r = client.post(f"{f.MANAGE()}/internal/subscriptions", bearer=k["manage_console_key"],
                    json_body={"cmp_id": cid, "app_key": "books", "status": "active",
                               "current_period_end": "2027-10-31T23:59:59Z", "source": "manual"})
    life = (((r.json or {}).get("data") or {}).get("subscription") or {}).get("lifecycle")
    ctx.check(r.status == 200 and life == "active", "operator records the renewal (status active) — restriction lifted at once", f"lifecycle={life}")
    manage_cli(["scripts/product_events.php", "--deliver"])
    ev = pg.json_rows(mdb, f"SELECT event, status FROM ghm_product_event_outbox WHERE cmp_id = {cid} ORDER BY id")
    ctx.check(any(e["event"] == "company_unrestricted" and e["status"] in ("delivered", "acked") for e in ev),
              "company_unrestricted delivered to Books", str(ev))
    st = pg.json_rows(bdb, f"SELECT state FROM books_company_lifecycle WHERE company_id = {cid}")
    ctx.check(st and st[0]["state"] == "active", "Books stored the lift", str(st))

    r = write("Retail Debtors South")
    ctx.check(r.status == 201, "Books accepts writes again right after the renewal", f"HTTP {r.status} {r.text[:200]}")
    st = pg.json_rows(bdb, f"SELECT state, source FROM books_company_lifecycle WHERE company_id = {cid}")
    ctx.check(st and st[0]["state"] == "active", "and stays active after Books re-reads companyinfo", str(st))
