<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use CodeIgniter\Database\RawSql;

class CreateSmokeRunDecisions extends Migration
{
    public function up(): void
    {
        $jsonType = $this->db->DBDriver === 'Postgre' ? 'JSONB' : 'JSON';

        $this->forge->addField([
            'id'              => ['type' => 'BIGINT', 'unsigned' => true, 'auto_increment' => true],
            'run_id'          => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'session_id'      => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'job_id'          => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'situation_key'   => ['type' => 'VARCHAR', 'constraint' => 191, 'null' => false],
            'question'        => ['type' => 'TEXT', 'null' => false],
            'options_json'    => ['type' => $jsonType, 'null' => false],
            'context_json'    => ['type' => $jsonType, 'null' => true],
            'screenshot_path' => ['type' => 'VARCHAR', 'constraint' => 512, 'null' => true],
            'status'          => ['type' => 'VARCHAR', 'constraint' => 32, 'default' => 'pending'],
            'selected_option' => ['type' => 'VARCHAR', 'constraint' => 191, 'null' => true],
            'free_text'       => ['type' => 'TEXT', 'null' => true],
            'answered_by'     => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'answered_at'     => ['type' => 'TIMESTAMP', 'null' => true],
            'remember'        => ['type' => 'BOOLEAN', 'default' => true],
            'created_at'      => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
            'updated_at'      => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey(['run_id', 'status']);
        $this->forge->addKey('session_id');
        $this->forge->addKey('job_id');
        $this->forge->addKey('situation_key');
        $this->forge->addForeignKey('run_id', 'smoke_observation_runs', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('session_id', 'smoke_sessions', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('job_id', 'smoke_session_jobs', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('answered_by', 'smoke_users', 'id', 'SET NULL', 'CASCADE');
        $this->forge->createTable('smoke_run_decisions');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_run_decisions', true);
    }
}
