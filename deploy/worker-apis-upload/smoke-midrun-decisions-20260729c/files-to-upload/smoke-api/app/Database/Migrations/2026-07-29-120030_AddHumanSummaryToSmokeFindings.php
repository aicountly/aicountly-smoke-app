<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

class AddHumanSummaryToSmokeFindings extends Migration
{
    public function up(): void
    {
        $this->forge->addColumn('smoke_ux_issues', [
            'human_summary' => ['type' => 'TEXT', 'null' => true],
        ]);
        $this->forge->addColumn('smoke_feature_gaps', [
            'human_summary' => ['type' => 'TEXT', 'null' => true],
        ]);
    }

    public function down(): void
    {
        $this->forge->dropColumn('smoke_feature_gaps', 'human_summary');
        $this->forge->dropColumn('smoke_ux_issues', 'human_summary');
    }
}
