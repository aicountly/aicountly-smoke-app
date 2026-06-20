<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

class CreateSmokeCredentials extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'                 => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'target_profile_id'  => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'ciphertext'         => ['type' => 'BYTEA', 'null' => false],
            'nonce'              => ['type' => 'BYTEA', 'null' => false],
            'auth_tag'           => ['type' => 'BYTEA', 'null' => false],
            'key_version'        => ['type' => 'INTEGER', 'default' => 1],
            'kind'               => ['type' => 'VARCHAR', 'constraint' => 32, 'default' => 'password'],
            'rotated_at'         => ['type' => 'TIMESTAMP', 'null' => true],
            'created_by'         => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'created_at'         => ['type' => 'TIMESTAMP', 'default' => 'CURRENT_TIMESTAMP'],
            'updated_at'         => ['type' => 'TIMESTAMP', 'default' => 'CURRENT_TIMESTAMP'],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey('target_profile_id');
        $this->forge->addForeignKey('target_profile_id', 'smoke_target_profiles', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('created_by', 'smoke_users', 'id', 'SET NULL', 'CASCADE');
        $this->forge->createTable('smoke_credentials');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_credentials', true);
    }
}
