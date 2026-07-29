<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

class AddCursorFieldsToSmokeFeatureGaps extends Migration
{
    public function up(): void
    {
        // Apply before deploying workers that send these fields.
        $this->forge->addColumn('smoke_feature_gaps', [
            'confidence'    => ['type' => 'VARCHAR', 'constraint' => 16, 'default' => 'low'],
            'mode'          => ['type' => 'VARCHAR', 'constraint' => 24, 'default' => 'validate_first'],
            'evidence_json' => ['type' => 'JSONB', 'null' => true],
        ]);
        $this->db->query("CREATE INDEX smoke_feature_gaps_mode_idx ON smoke_feature_gaps (mode)");
    }

    public function down(): void
    {
        $this->db->query('DROP INDEX IF EXISTS smoke_feature_gaps_mode_idx');
        $this->forge->dropColumn('smoke_feature_gaps', ['confidence', 'mode', 'evidence_json']);
    }
}
