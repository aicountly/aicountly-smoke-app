<?php

namespace App\Controllers;

use App\Services\ConsoleAccess\ConsoleUserAccessClient;
use CodeIgniter\HTTP\ResponseInterface;

class HealthController extends BaseController
{
    public function index(): ResponseInterface
    {
        // Token refresh re-checks Smoke roles with Console (CONSOLE_API_URL + CONSOLE_API_TOKEN;
        // required in production). Reported only, never a value: configuration, not the deploy —
        // the live verification (scripts/ci/live-feature-checks.py) fails on it instead.
        $roleSync = (new ConsoleUserAccessClient())->isConfigured();

        return $this->jsonOk([
            'service' => 'smoke.aicountly.org',
            'status'  => 'ok',
            'version' => '0.1.0',
            'time'    => date(DATE_ATOM),
            'checks'  => [
                'console_role_sync' => $roleSync
                    ? 'ok'
                    : 'CONSOLE_API_URL / CONSOLE_API_TOKEN not set — token refresh cannot re-check roles with Console (required in production)',
            ],
        ]);
    }
}
