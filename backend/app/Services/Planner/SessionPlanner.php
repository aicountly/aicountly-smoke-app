<?php

namespace App\Services\Planner;

use App\Services\Brain\BrainEnsemble;

/**
 * Turns a master prompt + target profile context into a structured session plan.
 *
 * The output `plan_json` shape is:
 *
 *   {
 *     "rationale": string,
 *     "product_name": string,
 *     "environment": string,
 *     "sessions": [
 *       {
 *         "ordinal": 1,
 *         "name": "Sales -> Invoices",
 *         "menu_path": "/sales/invoices",
 *         "description": "Observe invoice list, filters, exports, drill-down.",
 *         "scope": { "menus": [...], "screens": [...] },
 *         "allowed_actions": ["click_menu", "click_tab", "open_filter", "scroll"],
 *         "destructive_allowed": false,
 *         "expected_screens": 6
 *       }, ...
 *     ]
 *   }
 *
 * Sessions are split menu-wise and sub-divided when expected_screens > 8.
 */
class SessionPlanner
{
    public function __construct(private BrainEnsemble $brain) {}

    /**
     * @param array<string,mixed> $profile  Row from smoke_target_profiles
     * @return array<string,mixed>
     */
    public function plan(string $prompt, array $profile, string $environment): array
    {
        $sys = $this->systemPrompt();
        $usr = $this->userPrompt($prompt, $profile, $environment);

        $invocation = $this->brain->invoke('plan', $sys, $usr, [
            'expect_json' => true,
            'product'     => (string) ($profile['product_name'] ?? 'unknown'),
            'environment' => $environment,
        ]);

        $plan = $this->normalizePlan($invocation['final'] ?? null, $profile, $environment);
        $plan['_brain_meta'] = [
            'arbiter'  => $invocation['arbiter']  ?? null,
            'parallel' => array_map(static function (array $r): array {
                return [
                    'provider'   => $r['provider']  ?? null,
                    'model'      => $r['model']     ?? null,
                    'latency_ms' => $r['latency_ms']?? null,
                    'error'      => $r['error']     ?? null,
                ];
            }, (array) ($invocation['parallel'] ?? [])),
        ];
        return $plan;
    }

    private function systemPrompt(): string
    {
        return <<<'PROMPT'
You are an internal AI session planner for AICOUNTLY's product intelligence
portal. The smoke portal logs into approved AICOUNTLY apps in OBSERVER MODE
ONLY -- it must NOT submit forms, modify data, post transactions, send mail,
print, export, generate, finalize, approve, reject, delete, reset, sync, or
reconcile.

Given a master prompt and a target app context, decompose the work into a list
of independent observation sessions, one per main menu / module. If a single
menu is large (>8 screens), split it into sub-sessions. Output ONE valid JSON
object that conforms exactly to this schema:

{
  "rationale": string,
  "product_name": string,
  "environment": string,
  "sessions": [
    {
      "ordinal": integer,
      "name": string,
      "menu_path": string,
      "description": string,
      "scope": { "menus": [string], "screens": [string] },
      "allowed_actions": [string],
      "destructive_allowed": false,
      "expected_screens": integer
    }
  ]
}

allowed_actions MUST be drawn from this safe vocabulary:
  click_menu, click_submenu, click_tab, open_filter, change_filter,
  open_dropdown, open_modal_readonly, scroll, screenshot, capture_console,
  capture_network, hover

NEVER include: submit_form, save, delete, post, approve, reject, finalize,
generate_invoice, file_return, send, upload, import, sync, reconcile, reset.

destructive_allowed MUST be false unless the user explicitly says
"ALLOW DESTRUCTIVE" in their prompt AND environment is sandbox or gh_staging.

Output ONLY the JSON object -- no prose, no markdown fences.
PROMPT;
    }

    private function userPrompt(string $prompt, array $profile, string $environment): string
    {
        $product = (string) ($profile['product_name'] ?? 'unknown');
        $allowedModules = (array) (json_decode((string) ($profile['allowed_modules'] ?? '[]'), true) ?: []);
        $baseUrl = (string) ($profile['base_url'] ?? '');
        $modulesLine = $allowedModules
            ? 'Allowed modules: ' . implode(', ', $allowedModules)
            : 'Allowed modules: (not specified -- discover from main navigation)';
        return <<<EOT
Target app product: {$product}
Environment: {$environment}
Base URL: {$baseUrl}
{$modulesLine}

Master prompt from user:
"""
{$prompt}
"""

Decompose the above into observation sessions following the schema.
EOT;
    }

    /** @param mixed $output */
    private function normalizePlan($output, array $profile, string $environment): array
    {
        $plan = is_array($output) ? $output : [];
        $plan['product_name'] = (string) ($plan['product_name'] ?? ($profile['product_name'] ?? 'unknown'));
        $plan['environment']  = (string) ($plan['environment']  ?? $environment);
        $plan['rationale']    = (string) ($plan['rationale']    ?? '');
        $sessions = [];
        $i = 1;
        foreach ((array) ($plan['sessions'] ?? []) as $s) {
            if (! is_array($s)) {
                continue;
            }
            $session = [
                'ordinal'             => (int) ($s['ordinal'] ?? $i),
                'name'                => trim((string) ($s['name'] ?? ('Session ' . $i))),
                'menu_path'           => (string) ($s['menu_path'] ?? ''),
                'description'         => (string) ($s['description'] ?? ''),
                'scope'               => is_array($s['scope'] ?? null) ? $s['scope'] : ['menus' => [], 'screens' => []],
                'allowed_actions'     => $this->sanitizeActions($s['allowed_actions'] ?? null),
                'destructive_allowed' => false, // safety: always start false; user toggles in UI
                'expected_screens'    => (int) ($s['expected_screens'] ?? 5),
            ];
            $sessions[] = $session;
            $i++;
        }
        if ($sessions === []) {
            $sessions = $this->defaultSessions($plan['product_name']);
        }
        $plan['sessions'] = $sessions;
        return $plan;
    }

    private function sanitizeActions($input): array
    {
        $allowed = [
            'click_menu', 'click_submenu', 'click_tab', 'open_filter', 'change_filter',
            'open_dropdown', 'open_modal_readonly', 'scroll', 'screenshot',
            'capture_console', 'capture_network', 'hover',
        ];
        $set = is_array($input) ? array_values(array_unique(array_filter($input, 'is_string'))) : [];
        $set = array_values(array_intersect($set, $allowed));
        return $set === [] ? ['click_menu', 'click_submenu', 'open_filter', 'screenshot', 'scroll'] : $set;
    }

    private function defaultSessions(string $product): array
    {
        return [
            ['ordinal' => 1, 'name' => 'Login + Dashboard',         'menu_path' => '/',          'description' => 'Land on dashboard, capture default view, observe top-level KPIs and shortcuts.', 'scope' => [], 'allowed_actions' => ['screenshot', 'scroll', 'capture_console'], 'destructive_allowed' => false, 'expected_screens' => 4],
            ['ordinal' => 2, 'name' => 'Primary Navigation Sweep',  'menu_path' => '/menu/*',    'description' => 'Walk every main menu and submenu, capture screenshots, list visible options.',     'scope' => [], 'allowed_actions' => ['click_menu', 'click_submenu', 'screenshot', 'scroll'], 'destructive_allowed' => false, 'expected_screens' => 12],
            ['ordinal' => 3, 'name' => 'Reports & Filters',         'menu_path' => '/reports/*', 'description' => 'Open each report screen, observe filters, exports, print/download options.',      'scope' => [], 'allowed_actions' => ['click_menu', 'open_filter', 'change_filter', 'screenshot'], 'destructive_allowed' => false, 'expected_screens' => 8],
            ['ordinal' => 4, 'name' => 'Settings & Configuration',  'menu_path' => '/settings/*','description' => 'Read-only walk through settings/configuration screens.',                            'scope' => [], 'allowed_actions' => ['click_menu', 'click_submenu', 'screenshot'], 'destructive_allowed' => false, 'expected_screens' => 6],
        ];
    }
}
