<?php

namespace App\Commands;

use CodeIgniter\CLI\BaseCommand;
use CodeIgniter\CLI\CLI;
use Config\Database;
use Config\Services;

/**
 * php spark smoke:console-roles-sync
 *
 * Re-confirms every active Smoke user's roles with Console (user-access pull):
 * revoked users lose their roles and their refresh tokens stop working,
 * everyone else gets exactly the roles Console assigns. Optional — every token
 * refresh already does this and access tokens live at most 15 minutes — but a
 * cron entry also cleans up users who have gone idle, e.g.:
 *
 *   0 * * * *  cd ~/public_html/api && php spark smoke:console-roles-sync >/dev/null 2>&1
 */
class ConsoleRolesSync extends BaseCommand
{
    protected $group       = 'Smoke';
    protected $name        = 'smoke:console-roles-sync';
    protected $description = 'Re-sync every active Smoke user\'s roles from Console (needs CONSOLE_API_URL + CONSOLE_API_TOKEN).';

    public function run(array $params)
    {
        $sync = Services::consoleRoleSync();
        if (! $sync->isPullConfigured()) {
            CLI::error('CONSOLE_API_URL and CONSOLE_API_TOKEN must both be set; nothing to do.');

            return EXIT_ERROR;
        }

        $rows   = Database::connect()->table('smoke_users')->where('status', 'active')->get()->getResultArray();
        $counts = ['synced' => 0, 'revoked' => 0, 'kept' => 0, 'refused' => 0];

        foreach ($rows as $row) {
            $decision = $sync->checkAccess($row, true);
            if (! $decision->allowed) {
                $counts[$decision->revoke ? 'revoked' : 'refused']++;
                if ($decision->revoke) {
                    Services::audit()->record('auth.console_access_revoked', 'smoke_users', (string) $row['id'], null, [
                        'via' => 'smoke:console-roles-sync',
                    ]);
                }
                continue;
            }
            $counts[$decision->roles !== null ? 'synced' : 'kept']++;
        }

        CLI::write(sprintf(
            'Console role sync: %d users — %d synced, %d revoked, %d kept (Console unreachable, within 12h), %d refused (unreachable, stale).',
            count($rows),
            $counts['synced'],
            $counts['revoked'],
            $counts['kept'],
            $counts['refused'],
        ));

        return EXIT_SUCCESS;
    }
}
