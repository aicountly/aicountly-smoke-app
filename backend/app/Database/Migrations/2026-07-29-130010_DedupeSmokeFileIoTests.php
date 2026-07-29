<?php

namespace App\Database\Migrations;

use CodeIgniter\Database\Migration;

class DedupeSmokeFileIoTests extends Migration
{
    public function up(): void
    {
        $this->db->query(
            'DELETE FROM smoke_file_io_tests older
             USING smoke_file_io_tests newer
             WHERE older.run_id = newer.run_id
               AND older.session_id = newer.session_id
               AND older.scenario_key = newer.scenario_key
               AND older.id < newer.id',
        );
        $this->db->query(
            'CREATE UNIQUE INDEX IF NOT EXISTS smoke_file_io_tests_run_session_scenario_uq
             ON smoke_file_io_tests (run_id, session_id, scenario_key)',
        );
    }

    public function down(): void
    {
        $this->db->query('DROP INDEX IF EXISTS smoke_file_io_tests_run_session_scenario_uq');
    }
}
