<?php

namespace App\Database\Seeds;

use CodeIgniter\Database\Seeder;

class InitialSeeder extends Seeder
{
    public function run(): void
    {
        $this->call('RolesSeeder');
        $this->call('OwnerUserSeeder');
        $this->call('SettingsSeeder');
        $this->call('CompetitorBenchmarksSeeder');
    }
}
