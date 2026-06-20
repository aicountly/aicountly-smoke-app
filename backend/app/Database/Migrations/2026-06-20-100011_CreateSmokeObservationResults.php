<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use CodeIgniter\Database\RawSql;

class CreateSmokeObservationResults extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'                  => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'run_id'              => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'session_id'          => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'screen_url'          => ['type' => 'VARCHAR', 'constraint' => 1024, 'null' => true],
            'screen_title'        => ['type' => 'VARCHAR', 'constraint' => 512, 'null' => true],
            'module_name'         => ['type' => 'VARCHAR', 'constraint' => 191, 'null' => true],
            'screenshot_path'     => ['type' => 'VARCHAR', 'constraint' => 1024, 'null' => true],
            'page_metadata_json'  => ['type' => 'JSONB', 'null' => true],
            'console_errors_json' => ['type' => 'JSONB', 'null' => true],
            'network_errors_json' => ['type' => 'JSONB', 'null' => true],
            'performance_json'    => ['type' => 'JSONB', 'null' => true],
            'captured_at'         => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey('run_id');
        $this->forge->addKey('session_id');
        $this->forge->addForeignKey('run_id', 'smoke_observation_runs', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('session_id', 'smoke_sessions', 'id', 'CASCADE', 'CASCADE');
        $this->forge->createTable('smoke_observation_results');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_observation_results', true);
    }
}
