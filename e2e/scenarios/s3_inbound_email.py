"""3. Inbound e-mail: a raw RFC 822 message to grievance@ (with a PDF attachment) is piped to Flow's
scripts/inbound_email_pipe.php exactly as the MTA would; Flow creates a ticket escalated to level 2,
stores the attachment in object storage (OVH S3 stand-in: moto), notifies the officer and
acknowledges the sender automatically."""

import email.utils
from email.message import EmailMessage

from harness import client, config, pg, proc, services
from harness import fixtures as f

ID = "3"
TITLE = "Inbound e-mail to grievance@ -> ticket + L2 escalation + auto-ack (+ attachment to S3)"
SYSTEMS = "Flow (MTA pipe), object storage (moto), e-mail"

PDF = b"%PDF-1.4\n%e2e\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n" + b"0" * 4096


def pipe(raw: bytes):
    return proc.php_cli("flow-inbound", services.load_env("flow"), config.src("flow") / "server-php",
                        ["scripts/inbound_email_pipe.php"], stdin=raw, check=False)


def run(ctx):
    f.require("flow", "mail", "s3", "console")
    fdb = config.db("flow")

    m = EmailMessage()
    m["From"] = "Ravi Kumar <ravi.kumar@example.net>"
    m["To"] = "Grievance Officer <grievance@aicountly.com>"
    m["Subject"] = "Refund not received for invoice 7781"
    m["Message-ID"] = email.utils.make_msgid(domain="mail.example.net")
    m["Date"] = email.utils.formatdate()
    m.set_content("I paid Rs 4,999 on 2 Oct and the plan still shows Free. Support did not respond in 7 days. Statement attached.")
    m.add_attachment(PDF, maintype="application", subtype="pdf", filename="bank-statement-oct.pdf")
    raw = m.as_bytes()
    mid = m["Message-ID"].strip("<>")

    mark = f.mail_mark()
    p = pipe(raw)
    ctx.check(p.returncode == 0 and p.stdout == b"" and p.stderr == b"",
              "pipe script exits 0 and prints nothing (output would bounce the mail)", f"exit {p.returncode}")

    row = pg.json_rows(fdb, f"SELECT id, status, mailbox, ticket_id, ack_sent FROM desk_inbound_emails WHERE message_id = '{mid}'")
    ctx.check(row and row[0]["status"] == "processed" and row[0]["mailbox"] == "grievance" and row[0]["ack_sent"],
              "desk_inbound_emails: processed, mailbox grievance, ack sent", str(row))
    tid = int(row[0]["ticket_id"])
    t = pg.json_rows(fdb, f"SELECT ticket_number, created_via, grievance_level, priority, portal_email FROM tickets WHERE id = {tid}")[0]
    ctx.check(t["created_via"] == "email" and t["grievance_level"] == 2 and t["priority"] == "high"
              and t["portal_email"] == "ravi.kumar@example.net",
              "ticket created from the mail at grievance level 2, priority high, customer = sender", str(t))
    esc = pg.json_rows(fdb, f"SELECT level, requested_by_type, requested_by_email, officer_email, status FROM ticket_escalations WHERE ticket_id = {tid}")
    ctx.check(len(esc) == 1 and esc[0]["level"] == 2 and esc[0]["requested_by_type"] == "email",
              "ticket_escalations: level 2, requested_by_type email", str(esc))
    ref = f"{t['ticket_number']}-L2"

    m_off = f.wait_mail(lambda x: x["to"] == "grievance@aicountly.com" and ref in x["subject"], mark)
    m_ack = f.wait_mail(lambda x: x["to"] == "ravi.kumar@example.net" and t["ticket_number"] in x["subject"], mark)
    ctx.check(m_off is not None and m_off["sender_service"] == "flow", "Grievance Officer notified (Flow)", m_off["subject"] if m_off else "no mail")
    ctx.check(m_ack is not None and ref in m_ack["html"], "sender auto-acknowledged with the L2 reference and timelines",
              m_ack["subject"] if m_ack else "no mail")

    att = pg.json_rows(fdb, f"SELECT attachment_id, file_name, storage_key, mime_type, file_size FROM desk_attachments "
                            f"WHERE entity_type = 'ticket' AND entity_id = {tid}")
    ctx.check(len(att) == 1 and att[0]["mime_type"] == "application/pdf", "desk_attachments metadata row for the PDF", str(att))
    listing = client.get(f"{config.url('s3')}/flow.aicountly.org", query={"list-type": 2, "prefix": att[0]["storage_key"]})
    ctx.check(listing.status == 200 and f"<Size>{len(PDF)}</Size>" in listing.text,
              "the object is in the Flow bucket with the PDF's size (SigV4 PUT by DeskS3Storage into moto)", f"HTTP {listing.status}")
    staff = f.flow_session(f.console_superadmin())["token"]
    obj = client.get(f"{f.FLOW()}/desk/attachments/{att[0]['attachment_id']}", bearer=staff)
    ctx.check(obj.status == 200 and obj.body == PDF, "staff download it back through Flow (signed S3 GET), byte for byte",
              f"HTTP {obj.status}, {len(obj.body)} bytes")

    mark = f.mail_mark()
    p = pipe(raw)
    dup = pg.scalar(fdb, f"SELECT count(*) FROM desk_inbound_emails WHERE message_id = '{mid}'")
    ctx.check(p.returncode == 0 and dup == "1" and not f.mail_since(mark),
              "the same message delivered again is a duplicate: no second ticket, no second ack")

    tok = services.keys()["inbound_email"]
    r = client.post(f"{f.FLOW()}/public/inbound-email", query={"token": "wrong"}, data=raw, headers={"Content-Type": "message/rfc822"})
    ctx.check(r.status == 401, "the HTTPS ingestion endpoint refuses a wrong token", f"HTTP {r.status}")
    m2 = EmailMessage()
    m2["From"] = "Ravi Kumar <ravi.kumar@example.net>"
    m2["To"] = "pno@aicountly.com"
    m2["Subject"] = f"Not satisfied with {t['ticket_number']}"
    m2["Message-ID"] = email.utils.make_msgid(domain="mail.example.net")
    m2.set_content("The grievance officer has not resolved this. Escalating to the nodal officer.")
    r = client.post(f"{f.FLOW()}/public/inbound-email", query={"token": tok}, data=m2.as_bytes(), headers={"Content-Type": "message/rfc822"})
    d = (r.json or {}).get("data") or {}
    ctx.check(r.status == 200 and d.get("action") == "escalated" and int(d.get("level") or 0) == 3,
              "a follow-up to pno@ over the HTTPS endpoint escalates the SAME ticket to level 3", r.text[:200])
