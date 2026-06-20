<?php

namespace App\Database\Seeds;

use CodeIgniter\Database\Seeder;

class SettingsSeeder extends Seeder
{
    public function run(): void
    {
        $db = \Config\Database::connect();

        $defaults = [
            [
                'key'         => 'brain.default_arbiter',
                'value_json'  => json_encode('gemini'),
                'description' => 'Arbiter provider used by Brain\\Ensemble for fan-in.',
                'is_secret'   => false,
            ],
            [
                'key'         => 'brain.parallel_providers',
                'value_json'  => json_encode(['openai', 'perplexity']),
                'description' => 'Providers consulted in parallel before arbitration.',
                'is_secret'   => false,
            ],
            [
                'key'         => 'brain.timeout_seconds',
                'value_json'  => json_encode(60),
                'description' => 'Per-provider request timeout (seconds).',
                'is_secret'   => false,
            ],
            [
                'key'         => 'search.provider',
                'value_json'  => json_encode('perplexity'),
                'description' => 'Configured market-research search provider.',
                'is_secret'   => false,
            ],
            [
                'key'         => 'run_counter.last_date',
                'value_json'  => json_encode(''),
                'description' => 'Last YYYYMMDD on which a run code was issued.',
                'is_secret'   => false,
            ],
            [
                'key'         => 'run_counter.last_seq',
                'value_json'  => json_encode(0),
                'description' => 'Last 4-digit sequence on the current day.',
                'is_secret'   => false,
            ],
            [
                'key'         => 'safety.allow_destructive_actions_default',
                'value_json'  => json_encode(false),
                'description' => 'Default value of allow_destructive_actions when creating sessions.',
                'is_secret'   => false,
            ],
            [
                'key'         => 'safety.allow_production_demo_mode',
                'value_json'  => json_encode(false),
                'description' => 'Owner-only switch to permit safe demo mode against production targets.',
                'is_secret'   => false,
            ],
            [
                'key'         => 'reports.dir',
                'value_json'  => json_encode('./smoke-reports'),
                'description' => 'Filesystem directory where reports are written.',
                'is_secret'   => false,
            ],
            [
                'key'         => 'theme.primary',
                'value_json'  => json_encode('#10B981'),
                'description' => 'AICOUNTLY primary green hex.',
                'is_secret'   => false,
            ],
        ];

        foreach ($defaults as $row) {
            $exists = $db->table('smoke_settings')->where('key', $row['key'])->countAllResults();
            if ($exists === 0) {
                $db->table('smoke_settings')->insert($row);
            }
        }
    }
}
