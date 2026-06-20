<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

class CreateSmokeCompetitorProfiles extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'                => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'product_name'      => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => false],
            'competitor_name'   => ['type' => 'VARCHAR', 'constraint' => 191, 'null' => false],
            'feature_list_json' => ['type' => 'JSONB', 'null' => false],
            'source_url'        => ['type' => 'VARCHAR', 'constraint' => 512, 'null' => true],
            'enabled'           => ['type' => 'BOOLEAN', 'default' => true],
            'notes'             => ['type' => 'TEXT', 'null' => true],
            'created_at'        => ['type' => 'TIMESTAMP', 'default' => 'CURRENT_TIMESTAMP'],
            'updated_at'        => ['type' => 'TIMESTAMP', 'default' => 'CURRENT_TIMESTAMP'],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey('product_name');
        $this->forge->addUniqueKey(['product_name', 'competitor_name']);
        $this->forge->createTable('smoke_competitor_profiles');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_competitor_profiles', true);
    }
}
