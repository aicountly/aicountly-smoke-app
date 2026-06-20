<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use CodeIgniter\Database\RawSql;

class CreateSmokeFeatureGaps extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'                => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'run_id'            => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'session_id'        => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'product_name'      => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => false],
            'expected_feature'  => ['type' => 'VARCHAR', 'constraint' => 512, 'null' => false],
            'observed'          => ['type' => 'BOOLEAN', 'default' => false],
            'partial'           => ['type' => 'BOOLEAN', 'default' => false],
            'competitor_ref'    => ['type' => 'VARCHAR', 'constraint' => 191, 'null' => true],
            'severity'          => ['type' => 'VARCHAR', 'constraint' => 16, 'default' => 'medium'],
            'recommendation'    => ['type' => 'TEXT', 'null' => true],
            'developer_prompt'  => ['type' => 'TEXT', 'null' => true],
            'notes'             => ['type' => 'TEXT', 'null' => true],
            'sources_json'      => ['type' => 'JSONB', 'null' => true],
            'created_at'        => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey('run_id');
        $this->forge->addKey('session_id');
        $this->forge->addKey('product_name');
        $this->forge->addKey('observed');
        $this->forge->addForeignKey('run_id', 'smoke_observation_runs', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('session_id', 'smoke_sessions', 'id', 'SET NULL', 'CASCADE');
        $this->forge->createTable('smoke_feature_gaps');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_feature_gaps', true);
    }
}
