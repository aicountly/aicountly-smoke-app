"""8. Account restore from Flow: a customer closes the account, time moves into the suspended phase
(day 35: self-restore no longer possible), the customer e-mails support@ from the registered address
(Flow inbound pipe -> ticket), a Flow team lead (Console role) restores it from the ticket; Flow calls
my.aicountly's internal/account/restore over HTTPS with the service key; the account is active again."""

import email.utils
from email.message import EmailMessage

from harness import client, config, pg, proc, services
from harness import fixtures as f

ID = "8"
TITLE = "Account restore from Flow: closed (suspended) account -> Flow restore action -> portal internal/account/restore -> active"
SYSTEMS = "my.aicountly (via HTTPS front door), Flow, Console, e-mail"

UUID = 2008
LEAD = ("Tara Lead", "tara.lead@aicountly.example", "Tara-e2e-Pass1!")
AGENT = ("Deva Agent", "deva.agent@aicountly.example", "Deva-e2e-Pass1!")


def run(ctx):
    f.require("portal", "portal_tls", "flow", "console", "mail")
    pdb, fdb = config.db("portal"), config.db("flow")

    cust = f.customer("kiran", UUID, "Kiran", "Rao", "kiran.rao@example.test", "9845002008")
    r = client.post(f"{f.PORTAL()}/auth/account/delete", bearer=cust["auth"], json_body={"confirm": "DELETE"})
    ctx.check(r.status == 200 and (r.json or {}).get("phase") == "cooling_off", "customer closes the account on my.aicountly", r.text[:160])
    pg.run_sql(pdb, f"UPDATE useraictly SET useraictly_deletion_requested_at = useraictly_deletion_requested_at - INTERVAL '35 days' WHERE uuid = {UUID}")
    ctx.step("time moved: closed 35 days ago (suspended phase, DB timestamp)")
    r = client.post(f"{f.PORTAL()}/auth/login", json_body={"LoginName": cust["email"], "Password": cust["password"]})
    j = r.json or {}
    ctx.check(not j.get("aic_auth_token") and j.get("phase") == "suspended" and j.get("self_restore_available") is False,
              "sign-in refused: suspended, self-restore no longer available", r.text[:200])

    m = EmailMessage()
    m["From"] = f"Kiran Rao <{cust['email']}>"
    m["To"] = "support@aicountly.com"
    m["Subject"] = "Please restore my AICOUNTLY account"
    m["Message-ID"] = email.utils.make_msgid(domain="example.test")
    m.set_content("I closed my account by mistake last month and can no longer sign in. Please restore it.")
    mark = f.mail_mark()
    p = proc.php_cli("flow-inbound", services.load_env("flow"), config.src("flow") / "server-php",
                     ["scripts/inbound_email_pipe.php"], stdin=m.as_bytes(), check=False)
    tid = pg.scalar(fdb, f"SELECT ticket_id FROM desk_inbound_emails WHERE message_id = '{m['Message-ID'].strip('<>')}'")
    ctx.check(p.returncode == 0 and tid, "the customer's mail to support@ becomes a Flow ticket (inbound pipe)", f"ticket #{tid}")
    ack = f.wait_mail(lambda x: x["to"] == cust["email"], mark)
    ctx.check(ack is not None, "customer auto-acknowledged", ack["subject"] if ack else "no mail")

    admin = f.console_superadmin()
    agent_id = f.console_create_staff(admin, *AGENT)
    f.console_grant(admin, agent_id, "flow", "desk_operator")
    agent = f.flow_session(f.console_login(AGENT[1], AGENT[2]))
    r = client.post(f"{f.FLOW()}/desk/tickets/{tid}/account-restore", bearer=agent["token"],
                    json_body={"reason": "Customer asked from the registered address.", "identity_verified": True})
    ctx.check(r.status == 403, "a desk_operator may not restore accounts", f"HTTP {r.status}")

    lead_id = f.console_create_staff(admin, *LEAD)
    r = f.console_grant(admin, lead_id, "flow", "team_lead")
    ctx.check(r.status == 200, "superadmin grants Flow 'team_lead' in Console")
    lead = f.flow_session(f.console_login(LEAD[1], LEAD[2]))
    ctx.check("team_lead" in (lead.get("user") or {}).get("roles", []), "team lead signs in to Flow through Console SSO")

    r = client.post(f"{f.FLOW()}/desk/tickets/{tid}/account-restore", bearer=lead["token"],
                    json_body={"reason": "Customer wrote from the registered address asking to undo the closure.", "identity_verified": False})
    ctx.check(r.status == 422, "restore refused until the operator confirms the identity check", f"HTTP {r.status}")
    tls_log = proc.LOGS / "portal-tls.access.log"
    before = tls_log.read_text().count("/api/internal/account/restore") if tls_log.exists() else 0
    r = client.post(f"{f.FLOW()}/desk/tickets/{tid}/account-restore", bearer=lead["token"],
                    json_body={"reason": "Customer wrote from the registered address asking to undo the closure.", "identity_verified": True})
    ctx.check(r.status == 200 and ((r.json or {}).get("data") or {}).get("restored") is True,
              "team lead restores the account from the ticket (POST /api/desk/tickets/{id}/account-restore)", r.text[:200])
    after = tls_log.read_text().count("/api/internal/account/restore -> 200") if tls_log.exists() else 0
    ctx.check(after > before, "Flow called my.aicountly POST /api/internal/account/restore over HTTPS and got 200 (TLS front door log)")

    row = pg.json_rows(pdb, f"SELECT useraictly_status, useraictly_deletion_requested_at FROM useraictly WHERE uuid = {UUID}")
    ctx.check(row and row[0]["useraictly_status"] == 1 and row[0]["useraictly_deletion_requested_at"] is None,
              "portal: account active again, closure timestamp cleared", str(row))
    s = f.portal_login(cust["email"], cust["password"])
    ctx.check(bool(s.get("ses")), "the customer signs in again through the real portal")
    note = pg.scalar(fdb, f"SELECT count(*) FROM ticket_comments WHERE ticket_id = {tid} AND is_internal AND content LIKE 'Account restored%'")
    act = pg.scalar(fdb, f"SELECT count(*) FROM desk_activity_log WHERE entity_type = 'ticket' AND entity_id = {tid} AND action = 'ticket.account_restored'")
    aud = pg.scalar(fdb, f"SELECT count(*) FROM audit_logs WHERE action = 'user.portal_account_restored'")
    ctx.check(note == "1" and act == "1" and int(aud or 0) >= 1, "Flow records it: internal note, ticket activity, audit log",
              f"note={note} activity={act} audit={aud}")
    f.check_central_audit(ctx, "flow", "user.portal_account_restored",
                          "Console central audit has Flow's user.portal_account_restored, by the team lead",
                          f"AND lower(actor_email) = lower('{LEAD[1]}')")
    f.check_audit_outbox_drained(ctx, "flow")
    r = client.post(f"{config.url('portal')}/api/internal/account/restore", bearer="wrong",
                    json_body={"uuid": str(UUID), "operator_email": "x@y.z", "reason": "probe"})
    ctx.check(r.status == 401, "the portal endpoint refuses a wrong service key", f"HTTP {r.status}")
