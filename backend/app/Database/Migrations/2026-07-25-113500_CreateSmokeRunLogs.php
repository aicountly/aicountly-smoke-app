<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

class CreateSmokeRunLogs extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'          => ['type' => 'BIGINT', 'unsigned' => true, 'auto_increment' => true],
            'run_id'      => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'session_id'  => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'job_id'      => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'source'      => ['type' => 'VARCHAR', 'constraint' => 32, 'default' => 'system'],
            'level'       => ['type' => 'VARCHAR', 'constraint' => 16, 'default' => 'info'],
            'message'     => ['type' => 'TEXT', 'null' => false],
            'context_json'=> ['type' => 'JSONB', 'null' => true],
            'created_at'  => ['type' => 'TIMESTAMP', 'null' => false],
        ]);
        $this->forge->addKey('id', true);
        $this->forge->addKey(['run_id', 'created_at']);
        $this->forge->addKey('created_at');
        $this->forge->addForeignKey('run_id', 'smoke_observation_runs', 'id', 'CASCADE', 'CASCADE');
        $this->forge->createTable('smoke_run_logs');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_run_logs', true);
    }
}
