<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use CodeIgniter\Database\RawSql;

class CreateSmokeAuditLogs extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'           => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'user_id'      => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'action'       => ['type' => 'VARCHAR', 'constraint' => 128, 'null' => false],
            'entity'       => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => true],
            'entity_id'    => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => true],
            'ip'           => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => true],
            'user_agent'   => ['type' => 'VARCHAR', 'constraint' => 512, 'null' => true],
            'payload_json' => ['type' => 'JSONB', 'null' => true],
            'created_at'   => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey('user_id');
        $this->forge->addKey('action');
        $this->forge->addKey('entity');
        $this->forge->addKey('created_at');
        $this->forge->addForeignKey('user_id', 'smoke_users', 'id', 'SET NULL', 'CASCADE');
        $this->forge->createTable('smoke_audit_logs');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_audit_logs', true);
    }
}
