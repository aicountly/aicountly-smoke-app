<?php

namespace App\Services\Planner;

use App\Services\Brain\BrainEnsemble;
use Config\Environments;

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
 * Sessions are split menu-wise and sub-divided when the expected_screens planning estimate is > 8.
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

        $plan = $this->normalizePlan($invocation['final'] ?? null, $profile, $environment, $prompt);
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
portal. Observer-only tiers (production_readonly, production_restricted) never
write. On sandbox, gh_staging or production_full_access with profile
allow_safe_demo=true, plan for synthetic CREATE flows: fill forms, save/submit,
and upload/import fixtures. Irreversible controls (delete, approve, pay, void,
efile, send) remain permanently blocked in the worker regardless of the plan.

Given a master prompt and a target app context, decompose the work into a list
of independent observation sessions, one per main menu / module. If a single
menu is estimated to contain >8 screens, split it into sub-sessions as a
planning aid. expected_screens is a planning estimate only, not a runtime visit
quota; the worker discovers and visits relevant menus independently. Output ONE
valid JSON object that conforms exactly to this schema:

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
      "expected_screens": integer,
      "max_steps": integer
    }
  ]
}

max_steps is optional and nullable: an override for this session's action-step
budget; omit or set null to use the worker's global default. Heavy modules
like Payroll or Statutory Compliance may need up to 300 steps; simple modules
like Login or Dashboard need far fewer (roughly 40).

allowed_actions MUST be drawn from this vocabulary:
  click_menu, click_submenu, click_tab, open_filter, change_filter,
  open_dropdown, open_modal_readonly, scroll, screenshot, capture_console,
  capture_network, hover,
  fill_form, submit_form, create_record,
  download_file, export_file, upload_file, import_file, compare_file

On write-enabled profiles (full-access + allow_safe_demo), set
destructive_allowed=true and include fill_form, submit_form, create_record on
module sessions so the vision agent can create one synthetic SMOKE- record per
module. Never plan delete/approve/pay/void/efile actions.

Include one "File I/O & exports" session. In write-enabled environments it may
use upload_file, import_file, download_file, export_file, compare_file. Otherwise
use download_file and export_file for presence/export observation only.

When sessions have a data dependency (e.g. a Payroll session must run and
create a payroll record before a Statutory Compliance session can show
non-empty PF/ESI/TDS reports), assign the producing session a lower ordinal
than the consuming session, so the producer executes first within the plan.

Only plan a session for a module if you have evidence it exists in this
product's navigation (from the master prompt, prior scans, or the modules
list); do not invent sessions for modules that may not exist -- prefer
merging uncertain scope into a broader "Primary Navigation Sweep" session
instead.

Output ONLY the JSON object -- no prose, no markdown fences.
PROMPT;
    }

    private function userPrompt(string $prompt, array $profile, string $environment): string
    {
        $product = (string) ($profile['product_name'] ?? 'unknown');
        $allowedModules = (array) (json_decode((string) ($profile['allowed_modules'] ?? '[]'), true) ?: []);
        $baseUrl = (string) ($profile['base_url'] ?? '');
        $safeDemo = ! empty($profile['allow_safe_demo']) ? 'true' : 'false';
        $modulesLine = $allowedModules
            ? 'Allowed modules: ' . implode(', ', $allowedModules)
            : 'Allowed modules: (not specified -- discover from main navigation)';
        return <<<EOT
Target app product: {$product}
Environment: {$environment}
Base URL: {$baseUrl}
Profile allow_safe_demo: {$safeDemo}
{$modulesLine}

Master prompt from user:
"""
{$prompt}
"""

Decompose the above into observation sessions following the schema.
EOT;
    }

    /** @param mixed $output */
    private function normalizePlan($output, array $profile, string $environment, string $prompt): array
    {
        $plan = is_array($output) ? $output : [];
        $plan['product_name'] = (string) ($plan['product_name'] ?? ($profile['product_name'] ?? 'unknown'));
        $plan['environment']  = (string) ($plan['environment']  ?? $environment);
        $plan['rationale']    = (string) ($plan['rationale']    ?? '');
        $sessions = [];
        // Write-enabled when the tier allows full access and the profile opted into safe demo.
        // Irreversible labels remain permanently blocked in the worker guard.
        $mayEnableDestructive = Environments::allowsFullAccess($environment)
            && ! empty($profile['allow_safe_demo']);
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
                'allowed_actions'     => $this->sanitizeActions($s['allowed_actions'] ?? null, $mayEnableDestructive),
                'destructive_allowed' => $mayEnableDestructive && (($s['destructive_allowed'] ?? true) !== false),
                'expected_screens'    => (int) ($s['expected_screens'] ?? 5),
                'max_steps'           => isset($s['max_steps']) && is_numeric($s['max_steps']) ? (int) $s['max_steps'] : null,
            ];
            $sessions[] = $session;
            $i++;
        }
        $hasFileIo = array_filter($sessions, static fn (array $session): bool =>
            count(array_intersect(
                (array) ($session['allowed_actions'] ?? []),
                ['download_file', 'export_file', 'upload_file', 'import_file', 'compare_file'],
            )) > 0
        ) !== [];
        if (! $hasFileIo) {
            $fileActions = ['click_menu', 'click_submenu', 'download_file', 'export_file', 'compare_file', 'screenshot'];
            if ($mayEnableDestructive) {
                array_splice($fileActions, 4, 0, ['upload_file', 'import_file']);
            }
            $sessions[] = [
                'ordinal' => $i,
                'name' => 'File I/O & exports',
                'menu_path' => '/menu/*',
                'description' => 'Detect file controls and run approved synthetic fixture fidelity checks.',
                'scope' => ['menus' => [], 'screens' => []],
                'allowed_actions' => $fileActions,
                'destructive_allowed' => $mayEnableDestructive,
                'expected_screens' => 6,
            ];
        }
        if ($sessions === []) {
            $sessions = $this->defaultSessions($plan['product_name'], $mayEnableDestructive);
        }
        $plan['sessions'] = $sessions;
        return $plan;
    }

    private function sanitizeActions($input, bool $mayEnableDestructive): array
    {
        $allowed = [
            'click_menu', 'click_submenu', 'click_tab', 'open_filter', 'change_filter',
            'open_dropdown', 'open_modal_readonly', 'scroll', 'screenshot',
            'capture_console', 'capture_network', 'hover',
            'fill_form', 'submit_form', 'create_record',
            'download_file', 'export_file', 'upload_file', 'import_file', 'compare_file',
        ];
        $set = is_array($input) ? array_values(array_unique(array_filter($input, 'is_string'))) : [];
        $set = array_values(array_intersect($set, $allowed));
        if (! $mayEnableDestructive) {
            $set = array_values(array_diff($set, [
                'upload_file', 'import_file', 'fill_form', 'submit_form', 'create_record',
            ]));
        } elseif (array_intersect($set, ['click_menu', 'click_submenu', 'screenshot']) !== []) {
            foreach (['fill_form', 'submit_form', 'create_record'] as $writeAction) {
                if (! in_array($writeAction, $set, true)) {
                    $set[] = $writeAction;
                }
            }
        }
        if (array_intersect($set, ['download_file', 'export_file']) !== []
            && ! in_array('compare_file', $set, true)) {
            $set[] = 'compare_file';
        }
        return $set === [] ? ['click_menu', 'click_submenu', 'open_filter', 'screenshot', 'scroll'] : $set;
    }

    private function defaultSessions(string $product, bool $mayEnableDestructive): array
    {
        $navActions = ['click_menu', 'click_submenu', 'screenshot', 'scroll'];
        $reportActions = ['click_menu', 'open_filter', 'change_filter', 'screenshot'];
        if ($mayEnableDestructive) {
            array_push($navActions, 'fill_form', 'submit_form', 'create_record');
            array_push($reportActions, 'fill_form', 'submit_form', 'create_record');
        }
        $fileActions = ['click_menu', 'click_submenu', 'download_file', 'export_file', 'compare_file', 'screenshot'];
        if ($mayEnableDestructive) {
            array_splice($fileActions, 4, 0, ['upload_file', 'import_file']);
        }
        return [
            ['ordinal' => 1, 'name' => 'Login + Dashboard',         'menu_path' => '/',          'description' => 'Land on dashboard, capture default view, observe top-level KPIs and shortcuts.', 'scope' => [], 'allowed_actions' => ['screenshot', 'scroll', 'capture_console'], 'destructive_allowed' => false, 'expected_screens' => 4],
            ['ordinal' => 2, 'name' => 'Primary Navigation Sweep',  'menu_path' => '/menu/*',    'description' => 'Walk every main menu and submenu; create one synthetic SMOKE- record per module when forms exist.', 'scope' => [], 'allowed_actions' => $navActions, 'destructive_allowed' => $mayEnableDestructive, 'expected_screens' => 12],
            ['ordinal' => 3, 'name' => 'Reports & Filters',         'menu_path' => '/reports/*', 'description' => 'Open each report screen, observe filters, exports, and report standards against synthetic data.', 'scope' => [], 'allowed_actions' => $reportActions, 'destructive_allowed' => $mayEnableDestructive, 'expected_screens' => 8],
            ['ordinal' => 4, 'name' => 'Settings & Configuration',  'menu_path' => '/settings/*','description' => 'Walk through settings/configuration screens; create synthetic config only when safe.', 'scope' => [], 'allowed_actions' => $navActions, 'destructive_allowed' => $mayEnableDestructive, 'expected_screens' => 6],
            ['ordinal' => 5, 'name' => 'File I/O & exports',         'menu_path' => '/menu/*',    'description' => "Detect upload/import/download/export controls and test approved synthetic fixtures. Product: {$product}.", 'scope' => [], 'allowed_actions' => $fileActions, 'destructive_allowed' => $mayEnableDestructive, 'expected_screens' => 6],
        ];
    }
}
