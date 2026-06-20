<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use CodeIgniter\Database\RawSql;

class CreateSmokeObservationRuns extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'                  => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'run_code'            => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => false],
            'plan_id'             => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'target_profile_id'   => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'product_name'        => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => false],
            'environment'         => ['type' => 'VARCHAR', 'constraint' => 32, 'null' => false],
            'status'              => ['type' => 'VARCHAR', 'constraint' => 32, 'default' => 'queued'],
            'sessions_total'      => ['type' => 'INTEGER', 'default' => 0],
            'sessions_done'       => ['type' => 'INTEGER', 'default' => 0],
            'sessions_failed'     => ['type' => 'INTEGER', 'default' => 0],
            'started_at'          => ['type' => 'TIMESTAMP', 'null' => true],
            'completed_at'        => ['type' => 'TIMESTAMP', 'null' => true],
            'triggered_by'        => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'reports_dir'         => ['type' => 'VARCHAR', 'constraint' => 512, 'null' => true],
            'created_at'          => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
            'updated_at'          => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addUniqueKey('run_code');
        $this->forge->addKey('plan_id');
        $this->forge->addKey('product_name');
        $this->forge->addKey('environment');
        $this->forge->addKey('status');
        $this->forge->addForeignKey('plan_id', 'smoke_session_plans', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('target_profile_id', 'smoke_target_profiles', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('triggered_by', 'smoke_users', 'id', 'SET NULL', 'CASCADE');
        $this->forge->createTable('smoke_observation_runs');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_observation_runs', true);
    }
}
