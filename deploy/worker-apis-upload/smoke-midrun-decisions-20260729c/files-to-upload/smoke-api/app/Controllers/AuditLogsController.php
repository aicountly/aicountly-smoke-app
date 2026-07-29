<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Database;

class AuditLogsController extends BaseController
{
    public function index(): ResponseInterface
    {
        $db = Database::connect();
        $req = $this->request;
        $action = $req->getGet('action');
        $entity = $req->getGet('entity');
        $user = $req->getGet('user');
        $dateFrom = $req->getGet('date_from');
        $dateTo = $req->getGet('date_to');
        $excludeWorker = filter_var($req->getGet('exclude_worker'), FILTER_VALIDATE_BOOLEAN);
        $hasUser = filter_var($req->getGet('has_user'), FILTER_VALIDATE_BOOLEAN);
        $source = $req->getGet('source');

        if (is_string($dateTo) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $dateTo)) {
            $dateTo .= ' 23:59:59.999999';
        }

        $newQuery = static fn () => $db->table('smoke_audit_logs a')
            ->join('smoke_users u', 'u.id = a.user_id', 'left');

        $applyFilters = static function ($query) use (
            $action,
            $entity,
            $user,
            $dateFrom,
            $dateTo,
            $excludeWorker,
            $hasUser,
            $source
        ) {
            if ($action) {
                $query->like('a.action', $action, 'both');
            }
            if ($entity) {
                $query->like('a.entity', $entity, 'both');
            }
            if ($dateFrom) {
                $query->where('a.created_at >=', $dateFrom);
            }
            if ($dateTo) {
                $query->where('a.created_at <=', $dateTo);
            }
            if ($user) {
                $query->like('u.email', $user, 'both');
            }
            if ($excludeWorker) {
                $query
                    ->groupStart()
                        ->where('a.entity !=', 'worker')
                        ->orWhere('a.entity IS NULL', null, false)
                    ->groupEnd()
                    ->groupStart()
                        ->notLike('a.action', '/api/v1/worker', 'both')
                        ->orWhere('a.action IS NULL', null, false)
                    ->groupEnd();
            }
            if ($source === 'semantic') {
                $query->where("a.action !~ '^(GET|POST|PUT|PATCH|DELETE) '", null, false);
            } elseif ($source === 'http') {
                $query->where("a.action ~ '^(GET|POST|PUT|PATCH|DELETE) '", null, false);
            }
            if ($hasUser) {
                $query->where('a.user_id IS NOT NULL', null, false);
            }

            return $query;
        };

        $page  = max(1, (int) $req->getGet('page'));
        $size  = min(200, max(10, (int) ($req->getGet('size') ?? 50)));
        $total = $applyFilters($newQuery())->countAllResults();
        $rows  = $applyFilters($newQuery())
            ->select('a.id, a.action, a.entity, a.entity_id, a.ip, a.user_agent, a.created_at, a.payload_json, u.email AS user_email')
            ->orderBy('a.created_at', 'DESC')
            ->limit($size, ($page - 1) * $size)
            ->get()
            ->getResultArray();

        return $this->jsonOk([
            'data' => $rows,
            'page' => $page,
            'size' => $size,
            'total' => $total,
        ]);
    }
}
