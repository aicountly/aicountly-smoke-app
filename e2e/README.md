# Cross-system E2E (`e2e/`)

Runs the **real** AICOUNTLY servers together on one machine and proves the flows that cross system
boundaries — Console roles reaching Flow, Manage's Help & Support writing into Flow's database,
my.aicountly account closure purging data in Manage and Smart Books, Manage subscriptions
restricting Books, Flow handing work to Build, Flow restoring a my.aicountly account, account closure
reaching Flow's retention timeline, Books legal holds and machine-write deferral, cron jobs reporting to
Console's Cron Job Monitor — instead of each repository testing against its own stub of the others.

```bash
e2e/run.sh                 # bring up, run all 13 scenarios, write e2e/report.md, tear down
e2e/run.sh --only 4,5      # some scenarios
e2e/run.sh --keep          # leave the stack running afterwards (then: e2e/run.sh --reuse --only 6)
e2e/run.sh --down          # stop a kept stack, drop its databases
```

Exit code 0 only when every scenario passed. The report (`e2e/report.md`) lists each scenario's
checks, the commit each service ran at (`+dirty` = uncommitted changes in that checkout were part
of the run), how each database was built, findings, and cross-service errors from the service logs.

## What runs

| Service | Repository (`$E2E_SRC_ROOT/<repo>`) | Served by | Schema |
|---|---|---|---|
| Console | console-react-app `server-php/public/index.php` | `php -S` | `scripts/migrate.php` |
| my.aicountly (portal) | my-aicountly-com `server-php/index.php` at `/api` | `php -S` | repo `tests/fixtures/portal_uuid_schema.sql` + code-derived auth/company tables (`e2e/sql/`, from console-react-app `ops/harness`) + repo `server-php/database/*.sql` — the repo ships no DDL for its core tables |
| Manage | manage-aicountly `server-php/public/index.php` | `php -S` | `database/schema.sql` + `scripts/migrate.php --run` |
| Flow | flow-react-app `server-php/public/index.php` | `php -S` | `schema.sql`, `seed.sql`, every `migrations/*.sql` (README "INITIAL SETUP"; `006_app_db_grants.sql` skipped — GRANTs to the cPanel role) |
| Smart Books | books-react-app `server-php/public/index.php` at `/api` | `php -S` | `spark migrate --all`, `spark books:sql-migrate`, `spark migrate --all` |
| Build | build-aicountly `server-php/index.php` at `/api` | `php -S` | `spark migrate --all -n` |

Each service gets its own database `e2e_<service>` (PostgreSQL 16 on 127.0.0.1:5432; the cluster is
started with `pg_ctlcluster 16 main start` when it is down) and runs under a clean environment
holding only its own variables, passed through the process environment — **no `.env` is written
into any checkout**. Outbound HTTP(S) proxies point at a dead port, so a mis-derived
`*.aicountly.com` host fails instead of reaching a live system. Manage reaches the Flow database
directly (`FLOW_DB_*`), as in production.

Cross-service wiring (all keys random per run, kept in `$E2E_STATE/secrets.json`):

| Caller → receiver | Variables |
|---|---|
| Flow, Build → Console (role re-check, SSO) | `CONSOLE_API_URL`, `CONSOLE_API_TOKEN` = a key issued by Console's own `scripts/notification_callers.php issue <app>` |
| Manage, Books → portal (session validation) | `AICOUNTLY_AUTH_URL`, `PORTAL_AUTH_BASE` |
| portal → Manage (account-closure purge) | `MANAGE_API_URL`, `MANAGE_ACCOUNT_PURGE_KEY` (both sides) |
| Manage ↔ Flow (signed account events, acks; Flow is a lifecycle-only app) | `LIFECYCLE_WEBHOOK_SECRET_FLOW` / `LIFECYCLE_WEBHOOK_URL_FLOW` (Manage), `LIFECYCLE_WEBHOOK_SECRET` + `MANAGE_API_URL` (Flow) |
| Manage, Flow, Build → Console cron monitor | `CONSOLE_CRON_MONITOR_KEY` (products; base = their `CONSOLE_API_URL`), `CRON_MONITOR_KEY_HASH` (Console) |
| Inventory-like sender → Books machine route (+ Manage company-status) | `INVENTORY_INBOUND_SERVICE_KEY` + `INVENTORY_INBOUND_SIGNING_SECRET` (Books, signed mode), the `inventory`-labelled key in `MANAGE_PRODUCT_SERVICE_KEYS` |
| Manage ↔ Books (signed lifecycle events, acks) | `LIFECYCLE_WEBHOOK_SECRET_BOOKS` / `LIFECYCLE_WEBHOOK_URL_BOOKS` (Manage), `LIFECYCLE_WEBHOOK_SECRET` + `MANAGE_API_URL` + `MANAGE_PRODUCT_SERVICE_KEY` (Books), `MANAGE_PRODUCT_SERVICE_KEYS=books:…,console:…` |
| operator → Manage subscriptions | the `console`-labelled key (`MANAGE_SUBSCRIPTION_ADMIN_LABELS=console`) |
| Flow → Build (handoff) | `BUILD_API_BASE_URL={build}/api/v1`, `BUILD_API_TOKEN` = Build's `BUILD_FLOW_INBOUND_TOKEN` |
| Flow → portal (account restore) | `PORTAL_ACCOUNT_RESTORE_URL` (https, through `stubs/tls_front.py`), `PORTAL_ACCOUNT_RESTORE_KEY` = portal `ACCOUNT_RESTORE_SERVICE_KEY` |
| everyone → e-mail | `EMAIL_API_URL` = the mail stub, a distinct `EMAIL_API_KEY` per service (so a captured mail names its sender) |

## Fakes (external systems only)

| Fake | For |
|---|---|
| `stubs/mail_stub.py` | Itwalk e-mail API (multipart `/email/1/send`, JSON `/email/3/send`), answers like Itwalk, captures every message to `$E2E_STATE/mail/messages.jsonl`. Console's login OTP is read from here, so staff sign in for real. |
| `stubs/tata_stub.py` | Tata Smartflo click-to-call over HTTPS per `flow-react-app/docs/TATA_TELE_CLICK_TO_CALL.md`; records each request and pushes `ringing` + `answered` webhooks to Flow. |
| `moto_server` | OVH S3 (path-style, SigV4); `run.sh` installs `moto[server]` into `$E2E_STATE/venv` when it is not on `PATH`. |
| `stubs/inventory_sender.php` | Inventory's outbox (scenario 11): signs like Inventory (`X-Inventory-Signature`), posts to Books' `integration/inventory/events`, and follows the sender rule with the company-lifecycle kit's own `DeferredSend` (canonical copy, manage-aicountly `Saas Common Handler/company-lifecycle`). |
| `stubs/tls_front.py` | not a fake — an HTTPS pass-through in front of the real portal, because Flow refuses a non-https restore URL and `php -S` has no TLS. A throwaway CA (`$E2E_STATE/tls`) is given to PHP with `-d curl.cainfo`. |

## Scenarios (`scenarios/`)

1. Console RBAC → Flow: staff user created through Console's API; superadmin grants Flow `grievance_officer`; real launch-key exchange; Flow session carries the role; revoke in Console → Flow refresh refused. Flow's `auth.login` / `auth.access_revoked` reach Console's `audit_logs` (central audit, `POST /portal/audit`).
2. Grievance: ticket through Manage's desk API (into the Flow DB) → staff resolve → customer escalates to L2 via Manage → officer (Console role) acknowledges and resolves via Flow → customer e-mails captured; `grievance.acknowledged` / `.resolved` reach Console's central audit and Flow's audit outbox is drained.
3. Inbound e-mail: raw MIME piped to Flow's `scripts/inbound_email_pipe.php` for grievance@ → ticket + L2 escalation + auto-ack; attachment stored in S3 and read back; follow-up to pno@ over the HTTPS endpoint → L3.
4. Account closure: portal closure-summary; delete without `confirm_company_loss` → 409 for a Manage-only owner (the gate reads Manage too); delete with it → day 46 (DB timestamp) → `spark accounts:purge-expired-deletions` → Manage `internal/account-closure/purge` → outbox delivers signed `company_purge_requested` → Books worker archives + purges + acks → Manage hard-deletes with a tombstone.
5. Subscription lapse: `internal/subscriptions` (operator key) cancelled + period end past → `company_lifecycle.php --apply` → `company_restricted` → Books 423 on writes, GET ok → renewal → `company_unrestricted` → writes work.
6. Flow → Build: bug → `desk/build-handoffs` → Build `POST v1/tasks` 201 → Build's own API (Console SSO) returns JSON payloads as arrays/objects; Flow's `build_handoff.queued` and Build's sign-in reach Console's central audit; a Build approval reaches Console only as an `approval.requested` audit event (Build sends nothing to the removed `/api/v1/portal/build/*`), both outboxes drained.
7. Tata click-to-call: Flow call endpoint → stub receives the documented payload → stub webhook → `desk_calls` completed.
8. Account restore: closure at day 35 (suspended) → mail to support@ → Flow team lead's restore action → portal `internal/account/restore` → account active, sign-in works; `user.portal_account_restored` reaches Console's central audit.
9. Account closure → Flow: a customer with a Manage ticket and an e-mailed one closes the account → day-46 sweep → Manage delivers `account_purge_requested` to Flow (account events only) → Flow's kit worker marks every record for anonymisation in 3 years (archived first, nothing deleted) → acks `purged` with the retained tables and reason → Manage's closure completed.
10. Books legal hold: `spark books:legal-hold --company=` → lapsed subscription past its 45-day window → Manage requests the purge → Books acks `held` (once, nothing touched) → Manage purge `blocked` (`legal_hold: books — …`), ops alerted once → hold lifted → purged (archive first) → Manage completes.
11. Machine write into a restricted company: Inventory-like stub sender → Books 423 `COMPANY_RESTRICTED` (event `deferred_restricted`, nothing applied) → sender keeps it deferred (kit `DeferredSend`), re-check asks Manage `company-status?app=books` → wait → renewal → resume → delivered.
12. Flow retention: marked records → +3 years (DB timestamps) → daily `--expire-retained` runs Flow's anonymisation sweep ("Deleted customer"), kit deletes nothing → +8 years → kit deletes the anonymised retention groups (archived first) and the stored attachment object in the bucket.
13. Cron monitor: Manage `product_events.php --deliver` / `company_lifecycle.php --apply`, Flow `console_audit_deliver.php`, Build `spark console:deliver-audit` → Console `portal/cron-heartbeat` → `cron_monitors` OK with that run (GET `admin/cron-monitors/{code}`); wrong key 401, unregistered monitor 404.

Cron jobs and workers (`product_events.php --deliver`, `company_lifecycle.php --apply`,
`books:company-lifecycle-worker`, Flow's kit `worker.php [--expire-retained]`, the portal purge sweep) are run by the scenarios as the cron would,
with the service's own environment. Time is moved only by updating the relevant DB timestamp.

## Requirements and footprint

PHP 8.2+ with `pdo_pgsql`, `curl`, `intl`, `mbstring`; PostgreSQL 16 server + client; Python 3.10+;
`openssl`; `composer` (only if `server-php/vendor` is missing in my-aicountly-com or build-aicountly —
`run.sh` installs it with `--no-dev` and removes what it installed at the end unless `E2E_KEEP_DEPS=1`).
Ports `E2E_PORT_BASE`+0…+13 (default 47100). Databases `e2e_*` only (dropped at the end). Files: the
state dir (`E2E_STATE`, default `/tmp/aicountly-e2e`) and each CodeIgniter checkout's git-ignored
`writable/`. To test a worktree: `E2E_SRC_FLOW=/path/to/flow-worktree e2e/run.sh`.
