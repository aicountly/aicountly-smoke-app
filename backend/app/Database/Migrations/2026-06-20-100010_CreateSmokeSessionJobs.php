<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

class CreateSmokeSessionJobs extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'              => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'run_id'          => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'session_id'      => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'ordinal'         => ['type' => 'INTEGER', 'null' => false],
            'status'          => ['type' => 'VARCHAR', 'constraint' => 32, 'default' => 'queued'],
            'leased_by'       => ['type' => 'VARCHAR', 'constraint' => 128, 'null' => true],
            'leased_at'       => ['type' => 'TIMESTAMP', 'null' => true],
            'lease_expires_at'=> ['type' => 'TIMESTAMP', 'null' => true],
            'attempts'        => ['type' => 'INTEGER', 'default' => 0],
            'max_attempts'    => ['type' => 'INTEGER', 'default' => 2],
            'last_error'      => ['type' => 'TEXT', 'null' => true],
            'created_at'      => ['type' => 'TIMESTAMP', 'default' => 'CURRENT_TIMESTAMP'],
            'updated_at'      => ['type' => 'TIMESTAMP', 'default' => 'CURRENT_TIMESTAMP'],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey(['run_id', 'ordinal']);
        $this->forge->addKey('status');
        $this->forge->addForeignKey('run_id', 'smoke_observation_runs', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('session_id', 'smoke_sessions', 'id', 'CASCADE', 'CASCADE');
        $this->forge->createTable('smoke_session_jobs');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_session_jobs', true);
    }
}
