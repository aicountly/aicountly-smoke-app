<?php

namespace App\Database\Seeds;

use CodeIgniter\Database\Seeder;

class RolesSeeder extends Seeder
{
    public function run(): void
    {
        $rows = [
            [
                'code'        => 'owner',
                'name'        => 'Owner',
                'description' => 'Full access: settings, target profiles, vault, plan approval, run, reports.',
            ],
            [
                'code'        => 'product_reviewer',
                'name'        => 'Product Reviewer',
                'description' => 'Create profiles, approve session plans, run observations, view reports.',
            ],
            [
                'code'        => 'developer_viewer',
                'name'        => 'Developer Viewer',
                'description' => 'Read-only access to all reports. Cannot create profiles or run observations.',
            ],
            [
                'code'        => 'auditor_viewer',
                'name'        => 'Auditor Viewer',
                'description' => 'Read-only access limited to reports flagged auditor_visible.',
            ],
        ];

        $db = \Config\Database::connect();
        foreach ($rows as $row) {
            $exists = $db->table('smoke_roles')->where('code', $row['code'])->countAllResults();
            if ($exists === 0) {
                $db->table('smoke_roles')->insert($row);
            }
        }
    }
}
