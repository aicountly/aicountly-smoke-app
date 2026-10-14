# AICOUNTLY cross-system E2E report

Generated 2026-10-14 05:45 UTC by `e2e/run.sh` in aicountly-smoke-app (43 s wall clock). PHP 8.3.6, PostgreSQL client 16.15-0ubuntu0.24.04.1), Python 3.13.16.

**Result: 8 passed, 0 failed, 0 not run** (of 8 scenarios).

## Scenarios

| # | Scenario | Systems crossed | Result | Checks | Time |
|---|---|---|---|---|---|
| 1 | Console RBAC -> Flow (SSO launch key, role sync, revocation on refresh) | Console, Flow | **PASS** | 22 pass / 0 fail | 3.1s |
| 2 | Grievance: Manage desk ticket -> L2 escalation via Manage -> Flow officer (Console role) acks/resolves | my.aicountly, Manage, Flow (shared Flow DB), Console, e-mail | **PASS** | 26 pass / 0 fail | 5.6s |
| 3 | Inbound e-mail to grievance@ -> ticket + L2 escalation + auto-ack (+ attachment to S3) | Flow (MTA pipe), object storage (moto), e-mail | **PASS** | 12 pass / 0 fail | 1.4s |
| 4 | Account closure -> portal purge -> Manage purge -> signed event -> Books archive+purge+ack -> Manage hard delete | my.aicountly, Manage, Smart Books, e-mail | **PASS** | 29 pass / 0 fail | 6.2s |
| 5 | Subscription lapse -> lifecycle job -> company_restricted -> Books 423 on writes, GET ok -> renewal -> unrestricted | Manage, Smart Books, my.aicountly, e-mail | **PASS** | 18 pass / 0 fail | 3.9s |
| 6 | Flow -> Build handoff: approved bug -> BuildApiClient -> Build POST v1/tasks 201 -> GET returns arrays | Flow, Build, Console (SSO into both) | **PASS** | 15 pass / 0 fail | 1.5s |
| 7 | Tata click-to-call: Flow call endpoint -> Smartflo stub (payload) -> stub webhook -> desk_calls updated | Flow, Tata Smartflo (stub), Console (SSO) | **PASS** | 11 pass / 0 fail | 2.2s |
| 8 | Account restore from Flow: closed (suspended) account -> Flow restore action -> portal internal/account/restore -> active | my.aicountly (via HTTPS front door), Flow, Console, e-mail | **PASS** | 16 pass / 0 fail | 4.5s |

## Stack under test

Every product is the repository's own server code, started with `php -S 127.0.0.1:<port>` on its own front controller, on its own fresh PostgreSQL database migrated with the repository's own runner, configured only through process environment variables (no `.env` is written into any checkout). Services call each other over HTTP with real per-pair keys; outbound proxies point at a dead port, so nothing can reach a live host.

| Service | Source (HEAD) | Port | Database | Boot | How it was built |
|---|---|---|---|---|---|
| console | console-react-app @ `ae41d2ab29` | 47100 | `e2e_console` | up | - |
| portal | my-aicountly-com @ `c70055b34f` | 47101 | `e2e_portal` | up | schema: repo tests/fixtures/portal_uuid_schema.sql + code-derived auth/company tables (console-react-app ops/harness) + repo server-php/database/*.sql — the repo ships no DDL for its core tables |
| manage | manage-aicountly @ `63c025ec18` | 47102 | `e2e_manage` | up | schema: repo database/schema.sql (grantee ghmanageaic_cmpaictly_user -> CURRENT_USER) + scripts/migrate.php --run |
| flow | flow-react-app @ `00e5206e81` | 47103 | `e2e_flow` | up | schema: repo schema.sql + seed.sql + every migrations/*.sql in name order (README INITIAL SETUP); skipped 006_app_db_grants.sql (GRANTs to the cPanel API role — the stack connects as the DB owner) |
| books | books-react-app @ `28a2dd36b2+dirty` | 47104 | `e2e_books` | up | schema: spark migrate --all, spark books:sql-migrate, spark migrate --all (deploy order, PHP step repeated on an empty DB) |
| build | build-aicountly @ `bbcef85a9f` | 47105 | `e2e_build` | up | schema: spark migrate --all -n (docs/deploy.md); no owner seed — staff come from Console |

Fakes, only for systems outside AICOUNTLY:

| Fake | Stands in for | Port | Status |
|---|---|---|---|
| `e2e/stubs/mail_stub.py` | Itwalk e-mail API (`/email/1/send` multipart, `/email/3/send` JSON) used by Console, Flow, Manage, my.aicountly; every message captured to JSON lines and asserted on | 47110 | up |
| `moto_server` | OVH Object Storage (S3, path-style, SigV4) — Flow desk attachments bucket `flow.aicountly.org` | 47112 | up |
| `e2e/stubs/tata_stub.py` | Tata Smartflo click-to-call (`POST /v1/click_to_call`) + call-status webhooks, HTTPS | 47111 | up |
| `e2e/stubs/tls_front.py` | not a fake: an HTTPS front door to the real portal (Flow only calls an `https://` restore URL; `php -S` has no TLS) | 47113 | up |

Identity: Console staff sign in with password + the OTP Console e-mails (read from the mail stub); the seeded superadmin `pno@aicountly.com` gets a one-off password via SQL (its real hash is unknown here — migration 006 documents an explicit one-off UPDATE for this). Customers are inserted into the portal's user tables and then sign in through the real `POST /api/auth/login` + `POST /api/seskey`; the 15-minute session key's expiry is extended in the DB for the run (the key itself is the portal's). Time travel (day 35 / day 46 of a closure) is a DB timestamp update, stated in each scenario.

## Findings (defects observed that the scenarios do not assert)

- none

## Cross-service errors in the service logs (not asserted; for triage)

Lines from each service's PHP error log that record a failed call to another system or a refused event, de-duplicated (timestamps and ids stripped). Expected noise is filtered: Inventory, Contacts and the other services this stack does not run are pointed at a dead port on purpose.

- none

## Scenario detail

### 1. Console RBAC -> Flow (SSO launch key, role sync, revocation on refresh) — PASS

- PASS: superadmin pno@aicountly.com signs in to Console (password + OTP read from the captured e-mail)
- PASS: staff user created through Console POST /admin/users — `console user id 3`
- PASS: the new staff user signs in to Console (password + e-mailed OTP)
- PASS: without a Flow role Console refuses to launch Flow — `HTTP 403`
- PASS: superadmin grants Flow 'grievance_officer' (POST /admin/rbac/grants) — `{"success":true,"message":"Role granted.","data":{"app_code":"flow","granted":["grievance_officer"],"revoked":[],"roles":["grievance_officer"]},"errors":[]}`
- PASS: Console audit_logs records role.grant — `rows=1`
- PASS: Flow's own Console key (issued by scripts/notification_callers.php) reads the user's Flow roles — `HTTP 200 {'exists': True, 'active': True, 'app_access': True, 'app_superadmin': False, 'console_user_id': 3, 'email': 'vikram.rana@aicountly.example', 'name': 'Vikram Rana', 'app_roles': ['grievance_officer'], 'authz_version': 2}`
- PASS: Flow exchanges the Console launch key (POST /api/auth/controller-sso -> Console /auth/sso/exchange) — `HTTP 200`
- PASS: the Flow session carries the Console role — `user.roles=['grievance_officer', 'desk_operator']`
- PASS: Console central audit has Flow's auth.login for the user (POST /portal/audit with Flow's own key) — `1 row(s); last={'id': 7, 'source_app': 'flow', 'caller_code': 'flow', 'action': 'auth.login', 'entity_type': 'user', 'entity_ref': '2', 'actor_email': 'vikram.rana@aicountly.example', 'external_id': 'flow:audit_logs:1', 'occurred_at': '2026-10-14T05:45:18+00:00'}`
- PASS: the launch key is single-use (second exchange refused) — `HTTP 401`
- PASS: Flow DB: user provisioned with console_user_id and user_app_roles from Console — `[{'id': 2, 'console_user_id': 3, 'access_revoked_at': None, 'roles': ['grievance_officer']}]`
- PASS: the role is usable in Flow (GET /api/desk/grievances) — `HTTP 200`
- PASS: token refresh re-checks Console user-access and keeps the role — `HTTP 200`
- PASS: superadmin revokes the role in Console (POST /admin/rbac/revocations) — `{"success":true,"message":"Role revoked.","data":{"app_code":"flow","granted":[],"revoked":["grievance_officer"],"roles":[]},"errors":[]}`
- PASS: Console user-access now answers app_access=false — `{'exists': True, 'active': True, 'app_access': False, 'app_superadmin': False, 'console_user_id': 3, 'email': 'vikram.rana@aicountly.example', 'name': 'Vikram Rana', 'app_roles': [], 'authz_version': 3}`
- PASS: Flow refuses the next token refresh — `HTTP 401 {"success":false,"message":"Your Flow access was removed in Console. Ask a Console superadmin to assign you a role.","data":null,"errors":[]}`
- PASS: Console central audit has Flow's auth.access_revoked for the user — `1 row(s); last={'id': 9, 'source_app': 'flow', 'caller_code': 'flow', 'action': 'auth.access_revoked', 'entity_type': 'user', 'entity_ref': '2', 'actor_email': 'vikram.rana@aicountly.example', 'external_id': 'flow:audit_logs:2', 'occurred_at': '2026-10-14T05:45:19+00:00'}`
- PASS: the existing Flow token is refused on every later request (auth/me) — `HTTP 401`
- PASS: Flow DB: access_revoked_at set and the synced roles cleared — `[{'access_revoked_at': '2026-10-14T05:45:19.359258+00:00', 'n': 0}]`
- PASS: Console no longer launches Flow for the user — `HTTP 403`
- PASS: flow's central-audit outbox is drained: everything delivered to Console, nothing pending / dead / rejected — `{'delivered': 2}`

### 2. Grievance: Manage desk ticket -> L2 escalation via Manage -> Flow officer (Console role) acks/resolves — PASS

- PASS: customer signs in through the real portal (auth/login + seskey) — `uuid 2001`
- PASS: Manage POST /api/desk/tickets creates the ticket (session validated by the portal) — `{"success":"1","data":{"ticket_id":1,"ticket_number":"TCK-2026-00001"},"message":"Ticket created"}`
- PASS: the ticket is a row in the FLOW database, owned by the portal uuid — `[{'status': 'open', 'portal_uuid': '2001', 'portal_email': 'meera.iyer@example.test', 'created_via': 'product_portal', 'grievance_level': 1}]`
- PASS: customer attaches a screenshot through Manage: stored in the Flow bucket (moto), row in the Flow DB — `HTTP 201 [{'attachment_id': 1, 'storage_key': 'desk_ticket_1_2001_reconciliation-error_cb88c066.png', 'file_size': 78}]`
- PASS: Manage e-mails the customer about the new ticket — `Support ticket TCK-2026-00001 received`
- PASS: Flow staff download the customer's screenshot byte for byte (Manage wrote, Flow reads) — `HTTP 200, 78 bytes`
- PASS: Flow staff resolve the ticket (PUT /api/desk/tickets/{id}/status) — `HTTP 200`
- INFO: Manage shows the customer the escalation eligibility — `{'eligibility': {'current_level': 1, 'next_level': 2, 'eligible': True, 'code': 'eligible', 'message': 'You can escalate because your ticket was resolved and you are not satisfied.', 'available_at': None, 'basis': 'resolved_not_satisfied'}, 'levels': [{'level': 1, 'title': 'Support Team', 'name': 'S`
- PASS: customer escalates to level 2 through Manage (POST /api/desk/tickets/{id}/escalate) — `{"success":"1","message":"Escalated to the Grievance Officer. Your reference is TCK-2026-00001-L2.","data":{"id":1,"level":2,"reference":"TCK-2026-00001-L2","reason":"The reconciliation still fails with the same error af`
- PASS: Flow DB: ticket_escalations row (level 2, requested_by_type portal, statutory due dates) — `[{'id': 1, 'level': 2, 'status': 'open', 'requested_by_type': 'portal', 'requested_by_uuid': '2001', 'ack_due_at': '2026-10-15T05:45:21+00:00', 'resolve_due_at': '2026-10-29T05:45:21+00:00'}]`
- PASS: the ticket is re-opened at grievance level 2
- PASS: the Grievance Officer's public mailbox is notified (Manage) — `Grievance TCK-2026-00001-L2 — level 2 (Grievance Officer)`
- PASS: the customer receives the escalation acknowledgement with the L2 reference — `Your complaint TCK-2026-00001-L2 has been received`
- PASS: a desk_operator (no officer role) cannot act on a level-2 grievance — `HTTP 403`
- PASS: superadmin grants 'grievance_officer' in Console
- PASS: the officer's next Flow sign-in carries the role — `['grievance_officer', 'desk_operator']`
- PASS: the officer sees the escalation in Flow's grievance queue — `1 item(s)`
- PASS: officer acknowledges through Flow (POST /api/desk/grievances/{id}/acknowledge) — `HTTP 200`
- PASS: customer e-mailed the acknowledgement — `Complaint TCK-2026-00001-L2 acknowledged`
- PASS: officer resolves through Flow (POST /api/desk/grievances/{id}/resolve) — `HTTP 200`
- PASS: customer e-mailed the resolution text (and how to go to level 3) — `Complaint TCK-2026-00001-L2 resolved`
- PASS: Flow DB: escalation acknowledged + resolved — `[{'status': 'resolved', 'acknowledged_at': '2026-10-14T05:45:24.138589+00:00', 'resolved_at': '2026-10-14T05:45:24.33066+00:00', 'resolution': 'Root cause fixed: the HDFC CSV date column is now parsed`
- PASS: desk_activity_log records the officer's actions — `['grievance.acknowledged', 'grievance.resolved', 'ticket.assigned', 'ticket.attachment_added', 'ticket.created', 'ticket.escalated', 'ticket.status_changed']`
- PASS: the customer sees the resolved escalation back in Manage (same Flow DB) — `[{'id': 1, 'ticket_id': 1, 'level': 2, 'level_title': 'Grievance Officer', 'reference': 'TCK-2026-00001-L2', 'reason': 'The reconciliation still fails with the same error after the fix.', 'requested_b`
- PASS: Console central audit has Flow's grievance.acknowledged for the escalation, by the officer — `1 row(s); last={'id': 17, 'source_app': 'flow', 'caller_code': 'flow', 'action': 'grievance.acknowledged', 'entity_type': 'ticket_escalation', 'entity_ref': '1', 'actor_email': 'gita.officer@aicountly.example', 'external_id': 'flow:audit_logs:6', 'occurred_at': '2026-10-14T05:45:24+00:00'}`
- PASS: Console central audit has Flow's grievance.resolved for the escalation, by the officer — `1 row(s); last={'id': 18, 'source_app': 'flow', 'caller_code': 'flow', 'action': 'grievance.resolved', 'entity_type': 'ticket_escalation', 'entity_ref': '1', 'actor_email': 'gita.officer@aicountly.example', 'external_id': 'flow:audit_logs:7', 'occurred_at': '2026-10-14T05:45:24+00:00'}`
- PASS: flow's central-audit outbox is drained: everything delivered to Console, nothing pending / dead / rejected — `{'delivered': 7}`

### 3. Inbound e-mail to grievance@ -> ticket + L2 escalation + auto-ack (+ attachment to S3) — PASS

- PASS: pipe script exits 0 and prints nothing (output would bounce the mail) — `exit 0`
- PASS: desk_inbound_emails: processed, mailbox grievance, ack sent — `[{'id': 1, 'status': 'processed', 'mailbox': 'grievance', 'ticket_id': 2, 'ack_sent': True}]`
- PASS: ticket created from the mail at grievance level 2, priority high, customer = sender — `{'ticket_number': 'TCK-2026-00002', 'created_via': 'email', 'grievance_level': 2, 'priority': 'high', 'portal_email': 'ravi.kumar@example.net'}`
- PASS: ticket_escalations: level 2, requested_by_type email — `[{'level': 2, 'requested_by_type': 'email', 'requested_by_email': 'ravi.kumar@example.net', 'officer_email': 'grievance@aicountly.com', 'status': 'open'}]`
- PASS: Grievance Officer notified (Flow) — `Grievance TCK-2026-00002-L2 — level 2 (Grievance Officer)`
- PASS: sender auto-acknowledged with the L2 reference and timelines — `[TCK-2026-00002] Your complaint TCK-2026-00002-L2 has been received — Refund not received for invoice 7781`
- PASS: desk_attachments metadata row for the PDF — `[{'attachment_id': 2, 'file_name': 'bank-statement-oct.pdf', 'storage_key': 'uploads/desk/tickets/2/email/cfae7f26b49b-bank-statement-oct.pdf', 'mime_type': 'application/pdf', 'file_size': 4146}]`
- PASS: the object is in the Flow bucket with the PDF's size (SigV4 PUT by DeskS3Storage into moto) — `HTTP 200`
- PASS: staff download it back through Flow (signed S3 GET), byte for byte — `HTTP 200, 4146 bytes`
- PASS: the same message delivered again is a duplicate: no second ticket, no second ack
- PASS: the HTTPS ingestion endpoint refuses a wrong token — `HTTP 401`
- PASS: a follow-up to pno@ over the HTTPS endpoint escalates the SAME ticket to level 3 — `{"success":true,"message":"Message processed.","data":{"id":3,"status":"processed","reason":null,"action":"escalated","mailbox":"pno","ticket_id":2,"ticket_number":"TCK-2026-00002","reference":"TCK-20`

### 4. Account closure -> portal purge -> Manage purge -> signed event -> Books archive+purge+ack -> Manage hard delete — PASS

- PASS: customer creates a company through Manage (POST /api/companies/create) — `cmp_id 1`
- PASS: Books opens the company for its owner (portal session + Manage companyinfo; masters bootstrapped) — `HTTP 200`
- PASS: customer writes data in Books — `HTTP 201`
- INFO: Books rows for the company before closure (books_account_groups) — `32`
- PASS: closure summary lists the Manage-owned company (portal -> Manage internal/account-closure/companies) — `owned=[1] manage_companies_available=True`
- PASS: 30/45-day policy applies — `{'self_restore_days': 30, 'purge_after_days': 45, 'restore_until': '2026-11-13 11:15:29', 'purge_after': '2026-11-28 11:15:29'}`
- PASS: the owner holds no company in the portal's legacy store (Manage-only owner) — `legacy owned rows=0`
- PASS: delete without confirm_company_loss: 409 listing the Manage company (gate reads Manage, not only the legacy store) — `HTTP 409 {"success":"0","message":"You own 1 company. Hand them over to someone else, or confirm you want them permanently deleted along with your account.","owned_companies":[{"cmp_id":1,"cmp_name":"Mehta Exp`
- PASS: the refused request changed nothing (account still active)
- PASS: with confirm_company_loss the customer closes the account (POST /api/auth/account/delete) — `{"success":"1","message":"Your AICOUNTLY account is closed. You can restore it by signing in again until 13 Nov 2026 (30 days). After that it is suspended, and it is permanently deleted on 28 Nov 2026`
- PASS: portal: status 6 (pending deletion)
- PASS: portal e-mails the closure notice — `Your AICOUNTLY account has been closed`
- PASS: the customer's existing session is revoked at closure — `HTTP 401`
- INFO: time moved: deletion requested 46 days ago (DB timestamp)
- PASS: portal dry run lists the account as due — `r Time: 2026-10-14 11:15:30 UTC+05:30  Would permanently delete 1 account:   2004 (status 6, requested 2026-08-29 11:15:30) Would send 0 self-restore reminders.`
- PASS: portal purge sweep (php spark accounts:purge-expired-deletions) finalises — `CodeIgniter v4.1.8 Command Line Tool - Server Time: 2026-10-14 11:15:30 UTC+05:30  Permanently deleted 1 account. Self-restore reminders: 0 sent, 0 could not be sent.`
- PASS: portal: the person row is gone
- PASS: Manage accepted POST internal/account-closure/purge: whole-company purge, books asked — `[{'id': 1, 'status': 'waiting_acks', 'reason': 'account_closed', 'requested_by': 'account_closure:2004', 'apps': {'books': {'status': 'requested', 'event_id': '641297b3-3fe8-42d9-bce6-aa7f11c80f65', 'requested_at': '2026-10-14T05:45:30Z'}}}]`
- PASS: Manage reports the closure purge to the portal key (GET internal/account-closure/purge) — `HTTP 200`
- PASS: Manage outbox delivers the signed company_purge_requested to Books (Books answered 202) — `[{'status': 'delivered', 'last_http_status': 202}] {"delivery":{"claimed":2,"delivered":2,"retry":0,"dead":0,"skipped":0},"open_purges_checked":null,"alerts":0} {"outbox":{"pending":0,"delivered":2,"acked":0,"fa`
- PASS: Books verified the HMAC, stored the event, company purge_pending, job queued (nothing deleted in the request) — `[{'state': 'purge_pending', 'reason': 'account_closed'}] [{'status': 'pending'}]`
- PASS: Books data untouched until the worker runs
- PASS: Manage also delivers the per-person account_purge_requested to Books (202) — `[{'status': 'delivered', 'last_http_status': 202, 'last_error': None}]`
- PASS: Books worker (spark books:company-lifecycle-worker) runs the purge and the acks — `k 641297b3-3fe8-42d9-bce6-aa7f11c80f65 (purged) for company 1: sent ack fba64d19-7a18-441f-8352-1ee1c5cbfb42 (nothing_to_purge) for company 0: sent Company lifecycle: 1 purged, 1 with nothing to purge, 0 failed, 0 to retry; acks 2 sent, 0 to retry, 0 given up.`
- PASS: Books job: purged, ack answered 200 — `{'status': 'purged', 'archive_schema': 'lifecycle_archive_c1_20261014054532', 'rows_purged': 90, 'retained_json': '["books_audit_log","books_auth_events"]', 'ack_status': 'sent', 'ack_last_http': 200}`
- PASS: archive-first: every account-group row is in the archive schema and none left live — `archived=32 live=0 schema=lifecycle_archive_c1_20261014054532`
- PASS: Manage recorded Books' answer to the account purge (ghm_account_closure.apps, completed) — `[{'apps': {'books': {'detail': 'Books holds no personal data for this person outside companies. Retained under the statutory audit retention: books_auth_events.', 'status': 'nothing_to_purge', 'acked_at': '2026-10-14T05:45:32Z', 'event_id': 'fba64d19-7a18-441f-8352-1ee1c5cbfb42', 'retained': ['books`
- PASS: Manage: purge completed on Books' ack — `{'status': 'completed', 'completed_at': '2026-10-14T05:45:32+00:00', 'apps': {'books': {'detail': '90 row(s) from 9 table(s) archived into schema lifecycle_archive_c1_20261014054532 and removed. Retai`
- PASS: Manage: company hard-deleted
- PASS: Manage: tombstone row (lifecycle:account_closed) — `[{'cmp_id': 1, 'cmp_name': 'Mehta Exports Private Limited', 'cmp_code': 'CMPB10137A5', 'owner_uuid': '2004', 'deleted_by_uuid': 'lifecycle:account_closed', 'deleted_at': '2026-10-14T05:45:32.184466+00:00'}]`
- PASS: products see the company as deleted (GET internal/company-status) — `{"success":true,"data":{"companies":{"1":{"status":"deleted","cmp_name":"Mehta Exports Private Limited","deleted_at":"2026-10-14 05:45:32.184466+00","lifecycle":"active","restricted_until":null,"lifec`

### 5. Subscription lapse -> lifecycle job -> company_restricted -> Books 423 on writes, GET ok -> renewal -> unrestricted — PASS

- PASS: owner opens the company in Books — `cmp_id 2, HTTP 200`
- PASS: a write works while the subscription is active
- PASS: operator records an active paid Books subscription (POST internal/subscriptions, console-labelled key) — `{"success":true,"status":1,"data":{"changed":true,"subscription":{"id":1,"cmp_id":2,"app_key":"books","kind":"paid","status":"active","lifecycle":"active","curr`
- PASS: a product's own key may not write subscriptions (Books key refused) — `HTTP 403`
- PASS: operator cancels it with the period end already past — `{"success":true,"status":1,"data":{"changed":true,"subscription":{"id":1,"cmp_id":2,"app_key":"books","kind":"paid","status":"cancelled","lifecycle":"active","c`
- PASS: Manage daily job (scripts/company_lifecycle.php --apply) restricts the company — `{     "dry_run": false,     "at": "2026-10-14T05:45:35Z",     "restricted": [         {             "subscription_id": 1,             "cmp_id": 2,             "app_key": "books",             "kind": "paid",             "restricted_from": "2026-10-10T00:00:00Z",             "restricted_until": "2026-`
- PASS: Manage: subscription restricted, restricted_until set (45-day window) — `[{'status': 'restricted', 'restricted_from': '2026-10-10T00:00:00+00:00', 'restricted_until': '2026-11-24T00:00:00+00:00'}]`
- PASS: owner e-mailed the restricted notice with the deletion date — `Smart Books for Kapoor Textiles Private Limited is now view-only — data will be deleted on 24 Nov 2026`
- PASS: Manage outbox: company_restricted delivered to Books (signed HMAC POST) — `[{'event': 'company_restricted', 'status': 'delivered'}]`
- PASS: Books stored the restriction — `[{'state': 'restricted', 'source': 'event', 'reason': 'subscription_lapsed'}]`
- PASS: Manage companyinfo?app=books says restricted (HTTP 200, not 403) — `lifecycle=restricted`
- PASS: Books refuses a write with 423 COMPANY_RESTRICTED — `{"status":423,"code":"COMPANY_RESTRICTED","message":"This company is read-only until 24 Nov 2026 because its subscription ended. Renew to make changes, or export your data.","restricted_until":"2026-11-24T00:00:00Z","lif`
- PASS: Books still serves reads (GET masters/account-groups 200) — `HTTP 200`
- PASS: operator records the renewal (status active) — restriction lifted at once — `lifecycle=active`
- PASS: company_unrestricted delivered to Books — `[{'event': 'company_restricted', 'status': 'delivered'}, {'event': 'company_unrestricted', 'status': 'delivered'}]`
- PASS: Books stored the lift — `[{'state': 'active'}]`
- PASS: Books accepts writes again right after the renewal — `HTTP 201 {"data":{"acc_grp_id":65}}`
- PASS: and stays active after Books re-reads companyinfo — `[{'state': 'active', 'source': 'event'}]`

### 6. Flow -> Build handoff: approved bug -> BuildApiClient -> Build POST v1/tasks 201 -> GET returns arrays — PASS

- PASS: Flow admin files the bug (POST /api/desk/bugs) — `bug #1`
- INFO: bug status -> approved — `HTTP 200`
- PASS: Flow queues + dispatches the handoff (POST /api/desk/build-handoffs) — `handoff #1`
- PASS: Build accepted: Flow marks the handoff sent — `{'status': 'sent', 'build_task_ref': '1', 'response_payload': {'status': 'received', 'created': True, 'build_task_ref': 1, 'dev_request_id': 1, 'flow_handoff_id': 1}, 'error_message': None, 'attempts': 1}`
- PASS: Build answered 201 'Handoff accepted' with a dev request id — `{'status': 'received', 'created': True, 'build_task_ref': 1, 'dev_request_id': 1, 'flow_handoff_id': 1}`
- PASS: Build DB: build_flow_handoffs row linked to the dev request — `[{'flow_handoff_id': 1, 'source_type': 'bug', 'source_id': 1, 'dev_request_id': 1, 'status': 'acknowledged'}]`
- PASS: Flow stores Build's task reference (flow_build_handoffs.build_task_ref) — `build_task_ref='1', Build answered build_task_ref=1`
- PASS: Console central audit has Flow's build_handoff.queued for the handoff — `1 row(s); last={'id': 21, 'source_app': 'flow', 'caller_code': 'flow', 'action': 'build_handoff.queued', 'entity_type': 'build_handoff', 'entity_ref': '1', 'actor_email': 'pno@aicountly.com', 'external_id': 'flow:audit_logs:12', 'occurred_at': '2026-10-14T05:45:37+00:00'}`
- PASS: Build refuses a handoff without Flow's inbound token — `HTTP 401`
- PASS: a redelivered handoff is deduplicated on flow_handoff_id (200, created=false) — `HTTP 200`
- PASS: superadmin opens Build through the Console launch key (Build /v1/auth/controller-sso)
- PASS: Console central audit has Build's sign-in (auth.controller_sso_login, Build's own key) — `1 row(s); last={'id': 23, 'source_app': 'build', 'caller_code': 'build', 'action': 'auth.controller_sso_login', 'entity_type': None, 'entity_ref': None, 'actor_email': 'pno@aicountly.com', 'external_id': 'build:audit_logs:2', 'occurred_at': '2026-10-14T05:45:37+00:00'}`
- PASS: Build GET v1/flow-handoffs returns raw_payload as a JSON object with arrays (not a double-encoded string) — `type(raw_payload)=dict`
- PASS: Build GET v1/dev-requests/{id} returns metadata as an object, acceptance as an array — `type(metadata)=dict`
- PASS: flow's central-audit outbox is drained: everything delivered to Console, nothing pending / dead / rejected — `{'delivered': 10}`
- PASS: build's central-audit outbox is drained: everything delivered to Console, nothing pending / dead / rejected — `{'delivered': 2}`

### 7. Tata click-to-call: Flow call endpoint -> Smartflo stub (payload) -> stub webhook -> desk_calls updated — PASS

- INFO: ticket used — `#1`
- PASS: agent saves the call-back number (PUT /api/desk/me/call-phone) — `{"success":true,"message":"Call-back number saved.","data":{"call_phone":"919876543210"},"errors":[]}`
- PASS: Flow places the call (POST /api/desk/tickets/{id}/call) — `{"success":true,"message":"Calling \u2014 Smartflo will ring your phone first, then connect the customer.","data":{"id":1,"entity_type":"ticket","entity_id":1,"direction":"outbound","agent_user_id":3,`
- PASS: the Smartflo stub received exactly one click_to_call request — `1`
- PASS: request: POST /v1/click_to_call over HTTPS, raw token in Authorization (no 'Bearer') — `/v1/click_to_call`
- PASS: payload: agent_number, destination_number (digits with country code), caller_id, async, get_call_id — `{"agent_number": "919876543210", "destination_number": "919988776655", "caller_id": "918069990000", "async": 1, "get_call_id": 1}`
- PASS: the stub pushed ringing + answered webhooks to Flow's public endpoint, Flow answered 200 — `[200, 200]`
- PASS: desk_calls updated: completed, Smartflo call id, 95 s, https recording link — `{"status": "completed", "provider_call_id": "sf-e74e28d239064674", "answered_at": "2026-10-14T05:45:39+00:00", "ended_at": "2026-10-14T05:47:14+00:00", "duration_seconds": 95, "recording_url": "https://recordings.smartflo.example/sf-e74e28d239064674.mp3"}`
- INFO: ticket activity entries — `['ticket.call_placed', 'ticket.call_ended']`
- PASS: a provider retry of the final webhook is harmless — `HTTP 200`
- PASS: the call stays completed
- PASS: a webhook with the wrong token is refused — `HTTP 401`
- PASS: the ticket's Calls list shows the completed call — `1 call(s)`

### 8. Account restore from Flow: closed (suspended) account -> Flow restore action -> portal internal/account/restore -> active — PASS

- PASS: customer closes the account on my.aicountly — `{"success":"1","message":"Your AICOUNTLY account is closed. You can restore it by signing in again until 13 Nov 2026 (30 days). After that it is suspended, and `
- INFO: time moved: closed 35 days ago (suspended phase, DB timestamp)
- PASS: sign-in refused: suspended, self-restore no longer available — `{"pending_deletion":"1","policy":"standard_30_45","phase":"suspended","self_restore_available":false,"message":"This account is suspended and will be permanently deleted on 24 Oct 2026. It can no long`
- PASS: the customer's mail to support@ becomes a Flow ticket (inbound pipe) — `ticket #3`
- PASS: customer auto-acknowledged — `[TCK-2026-00003] We have received your message — Please restore my AICOUNTLY account`
- PASS: a desk_operator may not restore accounts — `HTTP 403`
- PASS: superadmin grants Flow 'team_lead' in Console
- PASS: team lead signs in to Flow through Console SSO
- PASS: restore refused until the operator confirms the identity check — `HTTP 422`
- PASS: team lead restores the account from the ticket (POST /api/desk/tickets/{id}/account-restore) — `{"success":true,"message":"Account restored. The account holder can sign in again.","data":{"restored":true,"message":"Account restored. The account holder can sign in again.","account":{"uuid":null,"`
- PASS: Flow called my.aicountly POST /api/internal/account/restore over HTTPS and got 200 (TLS front door log)
- PASS: portal: account active again, closure timestamp cleared — `[{'useraictly_status': 1, 'useraictly_deletion_requested_at': None}]`
- PASS: the customer signs in again through the real portal
- PASS: Flow records it: internal note, ticket activity, audit log — `note=1 activity=1 audit=1`
- PASS: Console central audit has Flow's user.portal_account_restored, by the team lead — `1 row(s); last={'id': 33, 'source_app': 'flow', 'caller_code': 'flow', 'action': 'user.portal_account_restored', 'entity_type': 'ticket', 'entity_ref': '3', 'actor_email': 'tara.lead@aicountly.example', 'external_id': 'flow:audit_logs:17', 'occurred_at': '2026-10-14T05:45:44+00:00'}`
- PASS: flow's central-audit outbox is drained: everything delivered to Console, nothing pending / dead / rejected — `{'delivered': 14}`
- PASS: the portal endpoint refuses a wrong service key — `HTTP 401`

## Boot log

```
AICOUNTLY cross-system e2e — state /tmp/aicountly-e2e, ports 47100+, databases e2e_*
  up   mail          0.1s  fake: Itwalk e-mail API (captures to JSON lines)
  up   s3            0.7s  fake: OVH S3 -> moto_server
  up   tata          0.1s  fake: Tata Smartflo click-to-call + webhooks (HTTPS)
  up   console       1.2s  real: console-react-app/server-php (plain PHP)
  up   portal        1.3s  real: my-aicountly-com/server-php (CodeIgniter 4)
  up   portal_tls    0.1s  TLS front door for the real portal (Flow requires https)
  up   manage        1.0s  real: manage-aicountly/server-php (plain PHP)
  up   flow          3.7s  real: flow-react-app/server-php (plain PHP)
  up   books         4.3s  real: books-react-app/server-php (CodeIgniter 4)
  up   build         1.4s  real: build-aicountly/server-php (CodeIgniter 4)
```

Logs of this run: `/tmp/aicountly-e2e/logs` (php -S access/error logs per service, `*.cli.log` for migrations and jobs, `http.calls.log` for every request a scenario made); captured mail: `/tmp/aicountly-e2e/mail/messages.jsonl`; Smartflo stub: `/tmp/aicountly-e2e/tata/calls.jsonl`.
