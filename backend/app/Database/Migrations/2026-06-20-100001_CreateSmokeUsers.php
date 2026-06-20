<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

class CreateSmokeUsers extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'              => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'email'           => ['type' => 'VARCHAR', 'constraint' => 191, 'null' => false],
            'password_hash'   => ['type' => 'VARCHAR', 'constraint' => 255, 'null' => false],
            'full_name'       => ['type' => 'VARCHAR', 'constraint' => 191, 'null' => false],
            'status'          => ['type' => 'VARCHAR', 'constraint' => 32, 'default' => 'active'],
            'must_rotate_pw'  => ['type' => 'BOOLEAN', 'default' => true],
            'mfa_enabled'     => ['type' => 'BOOLEAN', 'default' => false],
            'mfa_secret'      => ['type' => 'VARCHAR', 'constraint' => 255, 'null' => true],
            'last_login_at'   => ['type' => 'TIMESTAMP', 'null' => true],
            'last_login_ip'   => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => true],
            'created_at'      => ['type' => 'TIMESTAMP', 'default' => 'CURRENT_TIMESTAMP'],
            'updated_at'      => ['type' => 'TIMESTAMP', 'default' => 'CURRENT_TIMESTAMP'],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addUniqueKey('email');
        $this->forge->createTable('smoke_users');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_users', true);
    }
}
