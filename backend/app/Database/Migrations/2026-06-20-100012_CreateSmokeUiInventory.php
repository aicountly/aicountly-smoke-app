<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use CodeIgniter\Database\RawSql;

class CreateSmokeUiInventory extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'              => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'run_id'          => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'session_id'      => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'result_id'       => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'kind'            => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => false],
            'label'           => ['type' => 'VARCHAR', 'constraint' => 512, 'null' => true],
            'selector'        => ['type' => 'VARCHAR', 'constraint' => 1024, 'null' => true],
            'url'             => ['type' => 'VARCHAR', 'constraint' => 1024, 'null' => true],
            'payload_json'    => ['type' => 'JSONB', 'null' => true],
            'created_at'      => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey('run_id');
        $this->forge->addKey('session_id');
        $this->forge->addKey('kind');
        $this->forge->addForeignKey('run_id', 'smoke_observation_runs', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('session_id', 'smoke_sessions', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('result_id', 'smoke_observation_results', 'id', 'SET NULL', 'CASCADE');
        $this->forge->createTable('smoke_ui_inventory');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_ui_inventory', true);
    }
}
