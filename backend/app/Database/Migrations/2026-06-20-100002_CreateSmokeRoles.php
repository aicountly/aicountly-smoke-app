<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use CodeIgniter\Database\RawSql;

class CreateSmokeRoles extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'          => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'code'        => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => false],
            'name'        => ['type' => 'VARCHAR', 'constraint' => 128, 'null' => false],
            'description' => ['type' => 'TEXT', 'null' => true],
            'created_at'  => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addUniqueKey('code');
        $this->forge->createTable('smoke_roles');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_roles', true);
    }
}
