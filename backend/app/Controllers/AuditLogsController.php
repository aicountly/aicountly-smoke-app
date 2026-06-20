<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;

class AuditLogsController extends BaseController
{
    public function index(): ResponseInterface
    {
        $db = Database::connect();
        $q  = $db->table('smoke_audit_logs a')
            ->select('a.id, a.action, a.entity, a.entity_id, a.ip, a.created_at, a.payload_json, u.email AS user_email')
            ->join('smoke_users u', 'u.id = a.user_id', 'left')
            ->orderBy('a.created_at', 'DESC');

        $req = $this->request;
        foreach (['action', 'entity'] as $f) {
            if ($v = $req->getGet($f)) $q->like("a.{$f}", $v, 'both');
        }
        if ($from = $req->getGet('date_from')) {
            $q->where('a.created_at >=', $from);
        }
        if ($to = $req->getGet('date_to')) {
            $q->where('a.created_at <=', $to);
        }
        if ($u = $req->getGet('user')) {
            $q->like('u.email', $u, 'both');
        }
        $page  = max(1, (int) $req->getGet('page'));
        $size  = min(200, max(10, (int) ($req->getGet('size') ?? 50)));
        $rows  = $q->limit($size, ($page - 1) * $size)->get()->getResultArray();

        return $this->jsonOk([
            'data' => $rows,
            'page' => $page,
            'size' => $size,
        ]);
    }
}
