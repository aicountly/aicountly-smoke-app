<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

class CreateSmokeMasterPrompts extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'                    => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'user_id'               => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'target_profile_id'     => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'environment'           => ['type' => 'VARCHAR', 'constraint' => 32, 'null' => false],
            'title'                 => ['type' => 'VARCHAR', 'constraint' => 191, 'null' => false],
            'prompt_text'           => ['type' => 'TEXT', 'null' => false],
            'parsed_objective_json' => ['type' => 'JSONB', 'null' => true],
            'brain_response_json'   => ['type' => 'JSONB', 'null' => true],
            'status'                => ['type' => 'VARCHAR', 'constraint' => 32, 'default' => 'draft'],
            'created_at'            => ['type' => 'TIMESTAMP', 'default' => 'CURRENT_TIMESTAMP'],
            'updated_at'            => ['type' => 'TIMESTAMP', 'default' => 'CURRENT_TIMESTAMP'],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey('user_id');
        $this->forge->addKey('target_profile_id');
        $this->forge->addKey('status');
        $this->forge->addForeignKey('user_id', 'smoke_users', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('target_profile_id', 'smoke_target_profiles', 'id', 'CASCADE', 'CASCADE');
        $this->forge->createTable('smoke_master_prompts');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_master_prompts', true);
    }
}
