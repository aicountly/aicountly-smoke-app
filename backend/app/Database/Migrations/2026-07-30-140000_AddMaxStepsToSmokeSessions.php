<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

class AddMaxStepsToSmokeSessions extends Migration
{
    public function up(): void
    {
        $this->forge->addColumn('smoke_sessions', [
            'max_steps' => ['type' => 'INTEGER', 'null' => true],
        ]);
    }

    public function down(): void
    {
        $this->forge->dropColumn('smoke_sessions', 'max_steps');
    }
}
