<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;

class UiInventoryController extends BaseController
{
    public function index(int $runId): ResponseInterface
    {
        $db = Database::connect();
        $q  = $db->table('smoke_ui_inventory')->where('run_id', $runId);
        if ($kind = $this->request->getGet('kind')) {
            $q->where('kind', $kind);
        }
        $rows = $q->orderBy('created_at', 'ASC')->limit(2000)->get()->getResultArray();
        return $this->jsonOk(['data' => $rows]);
    }
}
