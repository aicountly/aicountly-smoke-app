<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;
use CodeIgniter\Database\RawSql;

class CreateSmokeTargetProfiles extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'                       => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'profile_name'             => ['type' => 'VARCHAR', 'constraint' => 191, 'null' => false],
            'product_name'             => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => false],
            'environment'              => ['type' => 'VARCHAR', 'constraint' => 32, 'null' => false],
            'base_url'                 => ['type' => 'VARCHAR', 'constraint' => 512, 'null' => false],
            'login_url'                => ['type' => 'VARCHAR', 'constraint' => 512, 'null' => false],
            'username'                 => ['type' => 'VARCHAR', 'constraint' => 191, 'null' => false],
            'allowed_domains'          => ['type' => 'JSONB', 'null' => true],
            'allowed_modules'          => ['type' => 'JSONB', 'null' => true],
            'observer_mode'            => ['type' => 'BOOLEAN', 'default' => true],
            'read_only'                => ['type' => 'BOOLEAN', 'default' => true],
            'production_restriction'   => ['type' => 'BOOLEAN', 'default' => true],
            'allow_safe_demo'          => ['type' => 'BOOLEAN', 'default' => false],
            'ip_restriction'           => ['type' => 'JSONB', 'null' => true],
            'login_strategy'           => ['type' => 'VARCHAR', 'constraint' => 64, 'default' => 'standard'],
            'extra_config'             => ['type' => 'JSONB', 'null' => true],
            'status'                   => ['type' => 'VARCHAR', 'constraint' => 32, 'default' => 'active'],
            'created_by'               => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'updated_by'               => ['type' => 'BIGINT', 'unsigned' => true, 'null' => true],
            'created_at'               => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
            'updated_at'               => ['type' => 'TIMESTAMP', 'default' => new RawSql('CURRENT_TIMESTAMP')],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey('product_name');
        $this->forge->addKey('environment');
        $this->forge->addKey('status');
        $this->forge->addForeignKey('created_by', 'smoke_users', 'id', 'SET NULL', 'CASCADE');
        $this->forge->addForeignKey('updated_by', 'smoke_users', 'id', 'SET NULL', 'CASCADE');
        $this->forge->createTable('smoke_target_profiles');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_target_profiles', true);
    }
}
