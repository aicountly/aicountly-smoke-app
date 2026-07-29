<?php

namespace App\Filters;

use Config\Database;
use CodeIgniter\Filters\FilterInterface;
use CodeIgniter\HTTP\RequestInterface;
use CodeIgniter\HTTP\ResponseInterface;

/**
 * Hard-stops destructive sessions on production profiles. There is no owner
 * override: production smoke runs remain observer-only.
 */
class ProductionGuardFilter implements FilterInterface
{
    public function before(RequestInterface $request, $arguments = null)
    {
        $body = $request->getJSON(true) ?? $request->getPost();
        $segments = $request->getUri()->getSegments();
        $db = Database::connect();
        $allowDestructive = (bool) ($body['destructive_allowed'] ?? false);
        $environment = strtolower(trim((string) ($body['environment'] ?? '')));

        $sessionPos = array_search('sessions', $segments, true);
        if ($sessionPos !== false && isset($segments[$sessionPos + 1]) && ctype_digit($segments[$sessionPos + 1])) {
            $row = $db->table('smoke_sessions s')
                ->select('s.destructive_allowed, tp.environment')
                ->join('smoke_session_plans sp', 'sp.id = s.plan_id')
                ->join('smoke_master_prompts mp', 'mp.id = sp.master_prompt_id')
                ->join('smoke_target_profiles tp', 'tp.id = mp.target_profile_id')
                ->where('s.id', (int) $segments[$sessionPos + 1])
                ->get()->getRowArray();
            $environment = strtolower((string) ($row['environment'] ?? $environment));
            if (! array_key_exists('destructive_allowed', $body)) {
                $allowDestructive = (bool) ($row['destructive_allowed'] ?? false);
            }
        }

        $planPos = array_search('session-plans', $segments, true);
        if ($planPos !== false && isset($segments[$planPos + 1]) && ctype_digit($segments[$planPos + 1])) {
            $planId = (int) $segments[$planPos + 1];
            $profile = $db->table('smoke_session_plans sp')
                ->select('tp.environment')
                ->join('smoke_master_prompts mp', 'mp.id = sp.master_prompt_id')
                ->join('smoke_target_profiles tp', 'tp.id = mp.target_profile_id')
                ->where('sp.id', $planId)->get()->getRowArray();
            $environment = strtolower((string) ($profile['environment'] ?? $environment));
            if (in_array(end($segments), ['run', 'approve'], true)) {
                $allowDestructive = $db->table('smoke_sessions')
                    ->where('plan_id', $planId)->where('destructive_allowed', true)->countAllResults() > 0;
            }
        }

        if (! $allowDestructive) {
            return; // observer-mode requests are always allowed
        }
        if (str_starts_with($environment, 'production')) {
            return service('response')->setStatusCode(403)->setJSON([
                'error'   => 'production_guard',
                'message' => 'Production profiles are observer-only; destructive_allowed cannot be enabled.',
            ]);
        }
    }

    public function after(RequestInterface $request, ResponseInterface $response, $arguments = null)
    {
        // no-op
    }
}
