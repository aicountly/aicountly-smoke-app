<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use CodeIgniter\Database\RawSql;

class CreateSmokeReports extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'                    => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'run_id'                => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'session_id'            => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'kind'                  => ['type' => 'VARCHAR', 'constraint' => 32, 'null' => false],
            'title'                 => ['type' => 'VARCHAR', 'constraint' => 255, 'null' => false],
            'severity_summary_json' => ['type' => 'JSONB', 'null' => true],
            'metrics_json'          => ['type' => 'JSONB', 'null' => true],
            'maturity_score'        => ['type' => 'NUMERIC', 'constraint' => '5,2', 'null' => true],
            'ux_score'              => ['type' => 'NUMERIC', 'constraint' => '5,2', 'null' => true],
            'html_path'             => ['type' => 'VARCHAR', 'constraint' => 1024, 'null' => true],
            'json_path'             => ['type' => 'VARCHAR', 'constraint' => 1024, 'null' => true],
            'auditor_visible'       => ['type' => 'BOOLEAN', 'default' => false],
            'created_at'            => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey('run_id');
        $this->forge->addKey('session_id');
        $this->forge->addKey('kind');
        $this->forge->addForeignKey('run_id', 'smoke_observation_runs', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('session_id', 'smoke_sessions', 'id', 'SET NULL', 'CASCADE');
        $this->forge->createTable('smoke_reports');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_reports', true);
    }
}
