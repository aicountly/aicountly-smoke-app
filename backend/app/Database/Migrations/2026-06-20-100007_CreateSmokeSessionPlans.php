<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use CodeIgniter\Database\RawSql;

class CreateSmokeSessionPlans extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'                => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'master_prompt_id'  => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'plan_json'         => ['type' => 'JSONB', 'null' => false],
            'rationale'         => ['type' => 'TEXT', 'null' => true],
            'status'            => ['type' => 'VARCHAR', 'constraint' => 32, 'default' => 'draft'],
            'session_count'     => ['type' => 'INTEGER', 'default' => 0],
            'approved_by'       => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'approved_at'       => ['type' => 'TIMESTAMP', 'null' => true],
            'rejected_reason'   => ['type' => 'TEXT', 'null' => true],
            'created_at'        => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
            'updated_at'        => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey('master_prompt_id');
        $this->forge->addKey('status');
        $this->forge->addForeignKey('master_prompt_id', 'smoke_master_prompts', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('approved_by', 'smoke_users', 'id', 'SET NULL', 'CASCADE');
        $this->forge->createTable('smoke_session_plans');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_session_plans', true);
    }
}
