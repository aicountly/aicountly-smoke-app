<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

class AddAgentStepsToSmokeSessions extends Migration
{
    public function up(): void
    {
        $this->forge->addColumn('smoke_sessions', [
            'agent_steps_json' => ['type' => 'JSONB', 'null' => true],
        ]);
    }

    public function down(): void
    {
        $this->forge->dropColumn('smoke_sessions', 'agent_steps_json');
    }
}
