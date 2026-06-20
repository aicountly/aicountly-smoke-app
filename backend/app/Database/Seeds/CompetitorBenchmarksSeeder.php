<?php

namespace App\Database\Seeds;

use CodeIgniter\Database\Seeder;

class CompetitorBenchmarksSeeder extends Seeder
{
    public function run(): void
    {
        $db = \Config\Database::connect();
        $rootSamples = realpath(WRITEPATH . '../../samples/competitors');
        if ($rootSamples === false || ! is_dir($rootSamples)) {
            return;
        }

        foreach (glob($rootSamples . DIRECTORY_SEPARATOR . '*.json') as $file) {
            $content = file_get_contents($file);
            if ($content === false) {
                continue;
            }
            $data = json_decode($content, true);
            if (! is_array($data) || empty($data['product_name']) || empty($data['competitors'])) {
                continue;
            }
            $product = (string) $data['product_name'];
            foreach ($data['competitors'] as $row) {
                $competitor = $row['name'] ?? null;
                if (! $competitor) {
                    continue;
                }
                $exists = $db->table('smoke_competitor_profiles')
                    ->where('product_name', $product)
                    ->where('competitor_name', $competitor)
                    ->countAllResults();
                if ($exists > 0) {
                    continue;
                }
                $db->table('smoke_competitor_profiles')->insert([
                    'product_name'      => $product,
                    'competitor_name'   => $competitor,
                    'feature_list_json' => json_encode($row['features'] ?? []),
                    'source_url'        => $row['source_url'] ?? null,
                    'enabled'           => true,
                    'notes'             => $row['notes'] ?? null,
                ]);
            }
        }
    }
}
