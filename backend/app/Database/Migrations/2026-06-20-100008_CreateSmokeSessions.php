<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

class CreateSmokeSessions extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'                       => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'plan_id'                  => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'ordinal'                  => ['type' => 'INTEGER', 'null' => false],
            'name'                     => ['type' => 'VARCHAR', 'constraint' => 191, 'null' => false],
            'menu_path'                => ['type' => 'VARCHAR', 'constraint' => 512, 'null' => true],
            'description'              => ['type' => 'TEXT', 'null' => true],
            'scope_json'               => ['type' => 'JSONB', 'null' => true],
            'allowed_actions_json'     => ['type' => 'JSONB', 'null' => true],
            'destructive_allowed'      => ['type' => 'BOOLEAN', 'default' => false],
            'expected_screens'         => ['type' => 'INTEGER', 'default' => 0],
            'status'                   => ['type' => 'VARCHAR', 'constraint' => 32, 'default' => 'pending'],
            'started_at'               => ['type' => 'TIMESTAMP', 'null' => true],
            'completed_at'             => ['type' => 'TIMESTAMP', 'null' => true],
            'error_message'            => ['type' => 'TEXT', 'null' => true],
            'created_at'               => ['type' => 'TIMESTAMP', 'default' => 'CURRENT_TIMESTAMP'],
            'updated_at'               => ['type' => 'TIMESTAMP', 'default' => 'CURRENT_TIMESTAMP'],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey(['plan_id', 'ordinal']);
        $this->forge->addKey('status');
        $this->forge->addForeignKey('plan_id', 'smoke_session_plans', 'id', 'CASCADE', 'CASCADE');
        $this->forge->createTable('smoke_sessions');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_sessions', true);
    }
}
