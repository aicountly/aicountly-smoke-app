<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use CodeIgniter\Database\RawSql;

class CreateSmokeUxIssues extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'              => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'run_id'          => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'session_id'      => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'result_id'       => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'category'        => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => false],
            'severity'        => ['type' => 'VARCHAR', 'constraint' => 16, 'null' => false],
            'title'           => ['type' => 'VARCHAR', 'constraint' => 512, 'null' => false],
            'description'     => ['type' => 'TEXT', 'null' => true],
            'recommendation'  => ['type' => 'TEXT', 'null' => true],
            'developer_prompt'=> ['type' => 'TEXT', 'null' => true],
            'evidence_json'   => ['type' => 'JSONB', 'null' => true],
            'created_at'      => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey('run_id');
        $this->forge->addKey('session_id');
        $this->forge->addKey('severity');
        $this->forge->addKey('category');
        $this->forge->addForeignKey('run_id', 'smoke_observation_runs', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('session_id', 'smoke_sessions', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('result_id', 'smoke_observation_results', 'id', 'SET NULL', 'CASCADE');
        $this->forge->createTable('smoke_ux_issues');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_ux_issues', true);
    }
}
