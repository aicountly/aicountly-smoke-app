<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use CodeIgniter\Database\RawSql;

class CreateSmokeUserRoles extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'user_id'     => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'role_id'     => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'assigned_at' => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
            'assigned_by' => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
        ]);
        $this->forge->addPrimaryKey(['user_id', 'role_id']);
        $this->forge->addForeignKey('user_id', 'smoke_users', 'id', 'CASCADE', 'CASCADE');
        $this->forge->addForeignKey('role_id', 'smoke_roles', 'id', 'CASCADE', 'CASCADE');
        $this->forge->createTable('smoke_user_roles');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_user_roles', true);
    }
}
