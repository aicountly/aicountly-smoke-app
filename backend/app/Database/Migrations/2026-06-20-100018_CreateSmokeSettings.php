<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use CodeIgniter\Database\RawSql;

class CreateSmokeSettings extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'          => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'key'         => ['type' => 'VARCHAR', 'constraint' => 128, 'null' => false],
            'value_json'  => ['type' => 'JSONB', 'null' => true],
            'description' => ['type' => 'TEXT', 'null' => true],
            'is_secret'   => ['type' => 'BOOLEAN', 'default' => false],
            'updated_by'  => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'updated_at'  => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
            'created_at'  => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addUniqueKey('key');
        $this->forge->addForeignKey('updated_by', 'smoke_users', 'id', 'SET NULL', 'CASCADE');
        $this->forge->createTable('smoke_settings');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_settings', true);
    }
}
