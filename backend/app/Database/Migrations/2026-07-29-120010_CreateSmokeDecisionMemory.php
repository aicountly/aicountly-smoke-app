<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use CodeIgniter\Database\RawSql;

class CreateSmokeDecisionMemory extends Migration
{
    public function up(): void
    {
        $jsonType = $this->db->DBDriver === 'Postgre' ? 'JSONB' : 'JSON';

        $this->forge->addField([
            'id'              => ['type' => 'BIGINT', 'unsigned' => true, 'auto_increment' => true],
            'product_name'    => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => false],
            'environment'     => ['type' => 'VARCHAR', 'constraint' => 32, 'null' => false],
            'situation_key'   => ['type' => 'VARCHAR', 'constraint' => 191, 'null' => false],
            'selected_option' => ['type' => 'VARCHAR', 'constraint' => 191, 'null' => false],
            'payload_json'    => ['type' => $jsonType, 'null' => true],
            'source_run_id'   => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'updated_by'      => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'created_at'      => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
            'updated_at'      => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addUniqueKey(['product_name', 'environment', 'situation_key']);
        $this->forge->addKey('source_run_id');
        $this->forge->addForeignKey('source_run_id', 'smoke_observation_runs', 'id', 'SET NULL', 'CASCADE');
        $this->forge->addForeignKey('updated_by', 'smoke_users', 'id', 'SET NULL', 'CASCADE');
        $this->forge->createTable('smoke_decision_memory');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_decision_memory', true);
    }
}
