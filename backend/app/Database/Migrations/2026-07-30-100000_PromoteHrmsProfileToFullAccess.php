<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

/**
 * Promote the live HRMS target profile to production_full_access so the vision
 * agent can create synthetic SMOKE- records and upload fixtures. Irreversible
 * controls remain permanently denied in the worker guard.
 */
class PromoteHrmsProfileToFullAccess extends Migration
{
    public function up(): void
    {
        $db = $this->db;
        $rows = $db->table('smoke_target_profiles')
            ->where('product_name', 'hrms')
            ->whereIn('environment', ['production_readonly', 'production_restricted'])
            ->get()
            ->getResultArray();

        foreach ($rows as $row) {
            $db->table('smoke_target_profiles')
                ->where('id', (int) $row['id'])
                ->update([
                    'environment'            => 'production_full_access',
                    'allow_safe_demo'        => true,
                    'read_only'              => false,
                    'observer_mode'          => false,
                    'production_restriction' => false,
                    'updated_at'             => date('Y-m-d H:i:s'),
                ]);
        }

        if ($db->table('smoke_settings')->where('key', 'brain.data_providers')->countAllResults() === 0) {
            $db->table('smoke_settings')->insert([
                'key'         => 'brain.data_providers',
                'value_json'  => json_encode(['perplexity', 'openai']),
                'description' => 'Ordered providers for synthetic test-data generation (first success wins).',
                'is_secret'   => false,
            ]);
        }
    }

    public function down(): void
    {
        $db = $this->db;
        $rows = $db->table('smoke_target_profiles')
            ->where('product_name', 'hrms')
            ->where('environment', 'production_full_access')
            ->get()
            ->getResultArray();

        foreach ($rows as $row) {
            $db->table('smoke_target_profiles')
                ->where('id', (int) $row['id'])
                ->update([
                    'environment'            => 'production_restricted',
                    'allow_safe_demo'        => false,
                    'read_only'              => true,
                    'observer_mode'          => true,
                    'production_restriction' => true,
                    'updated_at'             => date('Y-m-d H:i:s'),
                ]);
        }
    }
}
