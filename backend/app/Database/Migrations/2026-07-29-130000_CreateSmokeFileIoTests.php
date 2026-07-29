<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use CodeIgniter\Database\RawSql;

class CreateSmokeFileIoTests extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'                   => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'run_id'               => ['type' => 'BIGINT', 'unsigned' => true],
            'session_id'           => ['type' => 'BIGINT', 'unsigned' => true],
            'result_id'            => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'product_name'         => ['type' => 'VARCHAR', 'constraint' => 64],
            'scenario_key'         => ['type' => 'VARCHAR', 'constraint' => 191],
            'direction'            => ['type' => 'VARCHAR', 'constraint' => 16],
            'fixture_name'         => ['type' => 'VARCHAR', 'constraint' => 255],
            'upload_ok'            => ['type' => 'BOOLEAN', 'default' => false],
            'download_ok'          => ['type' => 'BOOLEAN', 'default' => false],
            'source_sha256'        => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => true],
            'result_sha256'        => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => true],
            'source_mime'          => ['type' => 'VARCHAR', 'constraint' => 128, 'null' => true],
            'result_mime'          => ['type' => 'VARCHAR', 'constraint' => 128, 'null' => true],
            'source_bytes'         => ['type' => 'BIGINT', 'null' => true],
            'result_bytes'         => ['type' => 'BIGINT', 'null' => true],
            'structure_ok'         => ['type' => 'BOOLEAN', 'default' => false],
            'structure_notes'      => ['type' => 'TEXT', 'null' => true],
            'compare_status'       => ['type' => 'VARCHAR', 'constraint' => 16],
            'ai_scores_json'       => ['type' => 'JSONB', 'null' => true],
            'ai_verdict'           => ['type' => 'TEXT', 'null' => true],
            'ai_recommendations'   => ['type' => 'JSONB', 'null' => true],
            'competitor_refs_json' => ['type' => 'JSONB', 'null' => true],
            'artifact_paths_json'  => ['type' => 'JSONB', 'null' => true],
            'evidence_json'        => ['type' => 'JSONB', 'null' => true],
            'created_at'           => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey('run_id');
        $this->forge->addKey('session_id');
        $this->forge->addKey('product_name');
        $this->forge->addKey('compare_status');
        $this->forge->addForeignKey('run_id', 'smoke_observation_runs', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('session_id', 'smoke_sessions', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('result_id', 'smoke_observation_results', 'id', 'SET NULL', 'CASCADE');
        $this->forge->createTable('smoke_file_io_tests');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_file_io_tests', true);
    }
}
