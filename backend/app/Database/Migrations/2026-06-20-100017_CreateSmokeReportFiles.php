<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

class CreateSmokeReportFiles extends Migration
{
    public function up(): void
    {
        $this->forge->addField([
            'id'         => ['type' => 'BIGSERIAL', 'unsigned' => true],
            'report_id'  => ['type' => 'BIGINT', 'unsigned' => true, 'null' => false],
            'file_path'  => ['type' => 'VARCHAR', 'constraint' => 1024, 'null' => false],
            'mime_type'  => ['type' => 'VARCHAR', 'constraint' => 64, 'null' => false],
            'size_bytes' => ['type' => 'BIGINT', 'null' => true],
            'sha256'     => ['type' => 'VARCHAR', 'constraint' => 128, 'null' => true],
            'kind'       => ['type' => 'VARCHAR', 'constraint' => 32, 'default' => 'evidence'],
            'created_at' => ['type' => 'TIMESTAMP', 'default' => 'CURRENT_TIMESTAMP'],
        ]);
        $this->forge->addPrimaryKey('id');
        $this->forge->addKey('report_id');
        $this->forge->addForeignKey('report_id', 'smoke_reports', 'id', 'CASCADE', 'CASCADE');
        $this->forge->createTable('smoke_report_files');
    }

    public function down(): void
    {
        $this->forge->dropTable('smoke_report_files', true);
    }
}
