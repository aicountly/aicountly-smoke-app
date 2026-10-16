<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

/**
 * Console assigns Smoke roles (app_code `smoke`; slugs = smoke_roles.code).
 * Adds the Console link and sync bookkeeping to smoke_users:
 *  - console_user_id / authz_version — the Console user and its authz version;
 *  - roles_synced_at — when local roles were last confirmed by Console;
 *  - sessions_revoked_at — refresh tokens issued before it are refused.
 * Also makes sure the four catalog roles exist.
 */
class AddConsoleRoleSyncToSmokeUsers extends Migration
{
    private const ROLES = [
        'owner'            => ['Owner', 'Full access: settings, target profiles, vault, plan approval, run, reports.'],
        'product_reviewer' => ['Product Reviewer', 'Create profiles, approve session plans, run observations, view reports.'],
        'developer_viewer' => ['Developer Viewer', 'Read-only access to all reports. Cannot create profiles or run observations.'],
        'auditor_viewer'   => ['Auditor Viewer', 'Read-only access limited to reports flagged auditor_visible.'],
    ];

    public function up(): void
    {
        $this->db->query('ALTER TABLE smoke_users ADD COLUMN IF NOT EXISTS console_user_id BIGINT NULL');
        $this->db->query('ALTER TABLE smoke_users ADD COLUMN IF NOT EXISTS roles_synced_at TIMESTAMP NULL');
        $this->db->query('ALTER TABLE smoke_users ADD COLUMN IF NOT EXISTS authz_version INTEGER NULL');
        $this->db->query('ALTER TABLE smoke_users ADD COLUMN IF NOT EXISTS sessions_revoked_at TIMESTAMP NULL');
        $this->db->query('CREATE INDEX IF NOT EXISTS smoke_users_console_user_id_idx ON smoke_users (console_user_id)');

        foreach (self::ROLES as $code => [$name, $description]) {
            $this->db->query(
                'INSERT INTO smoke_roles (code, name, description)
                 SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM smoke_roles WHERE code = ?)',
                [$code, $name, $description, $code],
            );
        }
    }

    public function down(): void
    {
        $this->db->query('DROP INDEX IF EXISTS smoke_users_console_user_id_idx');
        $this->db->query('ALTER TABLE smoke_users DROP COLUMN IF EXISTS sessions_revoked_at');
        $this->db->query('ALTER TABLE smoke_users DROP COLUMN IF EXISTS authz_version');
        $this->db->query('ALTER TABLE smoke_users DROP COLUMN IF EXISTS roles_synced_at');
        $this->db->query('ALTER TABLE smoke_users DROP COLUMN IF EXISTS console_user_id');
    }
}
