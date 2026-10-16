"""12. Flow's retention timeline for a closed account, end to end: the account purge marks the customer's
support records (as scenario 9); time moves 3 years (DB timestamps: the schedule and every marked row's
anonymise_after / retention_from) and the daily `worker.php --bootstrap=config/lifecycle-kit.php
--expire-retained` runs Flow's anonymisation sweep first ("Deleted customer", archived first) while the
kit's expiry deletes nothing; time moves to 8 years and the same daily run makes the kit delete the
anonymised records as retention groups (ticket + comments + escalation ...), archived first, and Flow's
expiry hook deletes the stored attachment object in the bucket."""

import json

from harness import client, config, pg, services
from harness import fixtures as f

ID = "12"
TITLE = "Flow retention: marked -> +3 years: anonymisation sweep -> +8 years: kit --expire-retained deletes the anonymised groups (+ S3 object)"
SYSTEMS = "my.aicountly, Manage, Flow (kit 1.1.1 expiry), object storage (moto)"

UUID = 2012
SUBJECT_TABLES = ("tickets", "ticket_comments", "ticket_escalations", "desk_attachments", "desk_activity_log")


def in_bucket(key: str) -> bool:
    """Whether the Flow bucket (moto) holds exactly this object key (bucket listing; objects are private)."""
    r = client.get(f"{config.url('s3')}/flow.aicountly.org", query={"list-type": "2", "prefix": key})
    return f"<Key>{key}</Key>" in r.text


def move_back(fdb: str, interval: str) -> None:
    """Simulated time: everything Flow dates for this customer happened `interval` earlier."""
    u = str(UUID)
    pg.run_sql(fdb, f"UPDATE flow_customer_anonymisation SET anonymise_after = anonymise_after - INTERVAL '{interval}', "
                    f"requested_at = requested_at - INTERVAL '{interval}' WHERE subject_uuid = '{u}'")
    for t in ("tickets", "bugs", "feature_requests", "ticket_escalations", "ticket_csat", "desk_reminders", "desk_activity_log",
              "desk_attachments"):
        pg.run_sql(fdb, f"UPDATE {t} SET anonymise_after = anonymise_after - INTERVAL '{interval}', "
                        f"retention_from = retention_from - INTERVAL '{interval}' WHERE retention_subject_uuid = '{u}'")
    for t in ("desk_inbound_emails", "desk_calls", "desk_email_outbox"):   # tied by address / number: anonymise_subject_uuid
        pg.run_sql(fdb, f"UPDATE {t} SET anonymise_after = anonymise_after - INTERVAL '{interval}', "
                        f"retention_from = retention_from - INTERVAL '{interval}' "
                        f"WHERE retention_subject_uuid = '{u}' OR anonymise_subject_uuid = '{u}'")


def run(ctx):
    f.require("portal", "manage", "flow", "books", "s3")
    fdb = config.db("flow")

    cust = f.customer("omar", UUID, "Omar", "Sheikh", "omar.sheikh@example.test", "9845002012")
    t = f.manage_desk_ticket(cust["ses"], "TDS certificate download fails", "Form 16A download shows a blank page.")
    tid = int(t["ticket_id"])
    shot = client.png(10, 10)
    body, ctype = client.multipart({}, {"file": ("form16a-error.png", "image/png", shot)})
    r = client.post(f"{f.MANAGE()}/desk/tickets/{tid}/attachments", bearer=cust["ses"], data=body, headers={"Content-Type": ctype})
    key = pg.scalar(fdb, f"SELECT storage_key FROM desk_attachments WHERE entity_type = 'ticket' AND entity_id = {tid}") or ""
    # Where the object really is: the stored key, or under the bucket's key prefix (Flow reads both).
    found = [c for c in (key, f"uploads/{key}") if in_bucket(c)]
    ctx.check(r.status == 201 and bool(found),
              "customer's ticket with a screenshot through Manage (row in the Flow DB, object in the Flow bucket)",
              f"ticket #{tid} storage_key={key} object={found}")
    admin = f.flow_session(f.console_superadmin())
    r = client.post(f"{f.FLOW()}/desk/tickets/{tid}/comments", bearer=admin["token"], json_body={"content": "We are looking into it.", "is_internal": False})
    ctx.step("staff reply on the ticket (POST desk/tickets/{id}/comments)", f"HTTP {r.status}")
    others = int(pg.scalar(fdb, f"SELECT count(*) FROM tickets WHERE id <> {tid}") or 0)

    f.close_account_and_purge(ctx, cust, UUID)
    f.manage_cli(["scripts/product_events.php", "--deliver"])
    services.books_cli(["books:company-lifecycle-worker", "--jobs=5", "--acks=50"])
    p, out = f.flow_lifecycle_worker()
    job = pg.json_rows(fdb, f"SELECT status FROM aic_lifecycle_jobs WHERE kind = 'account' AND target_uuid = '{UUID}'")
    marked = pg.scalar(fdb, f"SELECT count(*) FROM tickets WHERE id = {tid} AND retention_subject_uuid = '{UUID}' AND anonymise_after IS NOT NULL")
    ctx.check(job and job[0]["status"] == "purged" and marked == "1",
              "account purge delivered by Manage, Flow's worker marked the records (as scenario 9)", f"{job} marked={marked}")

    # Day 1: the daily run changes nothing.
    p, out = f.flow_lifecycle_worker(["--expire-retained"])
    exp = (out or {}).get("expire_retained") or {}
    ctx.check(p.returncode == 0 and exp.get("expired_rows") == 0 and
              pg.scalar(fdb, f"SELECT status FROM flow_customer_anonymisation WHERE subject_uuid = '{UUID}'") == "scheduled",
              "the daily --expire-retained before the date: nothing anonymised, nothing deleted", json.dumps(exp)[:200])

    # +3 years and a day: Flow's sweep anonymises (archived first); the kit's expiry deletes nothing yet.
    move_back(fdb, "3 years 1 day")
    ctx.step("time moved: the account purge was 3 years and a day ago (Flow DB timestamps)")
    p, out = f.flow_lifecycle_worker(["--expire-retained"])
    exp = (out or {}).get("expire_retained") or {}
    sweep = p.stderr.decode(errors="replace")
    ctx.check(p.returncode == 0 and '"anonymised":1' in sweep and exp.get("expired_rows") == 0,
              "daily --expire-retained at 3 years: Flow's anonymisation sweep runs first, the kit deletes nothing",
              (sweep.strip().splitlines() or [""])[-1][:240] + " " + json.dumps(exp)[:120])
    row = pg.json_rows(fdb, f"SELECT portal_uuid, portal_email, portal_name, description, retention_subject_uuid FROM tickets WHERE id = {tid}")
    ctx.check(row and row[0]["portal_email"] == "Deleted customer" and row[0]["portal_name"] == "Deleted customer"
              and row[0]["portal_uuid"] == "Deleted customer" and row[0]["retention_subject_uuid"] == str(UUID)
              and "Form 16A" in row[0]["description"],
              "ticket anonymised: identifiers 'Deleted customer', complaint text kept, only the opaque retention_subject_uuid left", str(row)[:240])
    sched = pg.json_rows(fdb, f"SELECT status, identifiers, detail->>'archive' AS archive FROM flow_customer_anonymisation WHERE subject_uuid = '{UUID}'")
    ctx.check(sched and sched[0]["status"] == "anonymised" and sched[0]["identifiers"] == {} and sched[0]["archive"],
              "the schedule is anonymised and keeps no identifiers; the sweep's archive is named", str(sched)[:240])
    ctx.check(int(pg.scalar(fdb, f"SELECT count(*) FROM tickets WHERE retention_subject_uuid = '{UUID}'") or 0) >= 1 and in_bucket(found[0]),
              "nothing deleted at 3 years (rows and the stored object stay until 8 years)")

    # +8 years: the kit deletes the anonymised groups, archived first; the expiry hook deletes the object.
    move_back(fdb, "5 years")
    ctx.step("time moved: the account purge was 8 years and a day ago")
    before = {tb: int(pg.scalar(fdb, f"SELECT count(*) FROM {tb}") or 0) for tb in SUBJECT_TABLES}
    p, out = f.flow_lifecycle_worker(["--expire-retained"])
    exp = (out or {}).get("expire_retained") or {}
    ctx.check(p.returncode == 0 and exp.get("failed") == 0 and exp.get("expired_rows", 0) >= 2,
              "daily --expire-retained at 8 years: the kit's retention expiry deletes the anonymised records", json.dumps(exp)[:300])
    ctx.check(pg.scalar(fdb, f"SELECT count(*) FROM tickets WHERE id = {tid}") == "0" and
              pg.scalar(fdb, f"SELECT count(*) FROM ticket_comments WHERE ticket_id = {tid}") == "0" and
              pg.scalar(fdb, f"SELECT count(*) FROM desk_attachments WHERE entity_type = 'ticket' AND entity_id = {tid}") == "0",
              "the ticket is deleted with its group (comments) and its attachment row")
    ctx.check(int(pg.scalar(fdb, f"SELECT count(*) FROM tickets WHERE id <> {tid}") or 0) == others,
              "every other customer's ticket stays", f"others={others}")
    grp = pg.json_rows(fdb, f"SELECT source_table, rows_deleted, reason, group_root, archive_name AS archive FROM aic_lifecycle_expiries WHERE target_uuid = '{UUID}' ORDER BY id")
    ctx.check(any(g["source_table"] == "public.tickets" for g in grp) and any(g["reason"] == "expired_with_group" and g["group_root"] == "public.tickets" for g in grp),
              "aic_lifecycle_expiries records the ticket and what expired with it (retention group)", str([(g['source_table'], g['reason']) for g in grp])[:300])
    arch = grp[0]["archive"] if grp else ""
    ctx.check(bool(arch) and pg.scalar(fdb, f'SELECT count(*) FROM "{arch}".tickets WHERE id = {tid}') == "1",
              "archived first: the deleted ticket is in the expiry archive schema", arch)
    left = [c for c in (key, f"uploads/{key}") if in_bucket(c)]
    ctx.check(left == [], "Flow's expiry hook deleted the stored attachment object from the bucket", f"still in the bucket: {left}")
    p, out = f.flow_lifecycle_worker(["--expire-retained"])
    ctx.check(((out or {}).get("expire_retained") or {}).get("expired_rows") == 0, "a second daily run has nothing to do")
