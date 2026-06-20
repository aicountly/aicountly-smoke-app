<?php

namespace App\Services\Audit;

use Config\Database;

/**
 * Writes a row to smoke_audit_logs. Never throws -- all logging failures are
 * swallowed and routed through CI's logger so they never block business flow.
 */
class AuditLogger
{
    public function record(
        string $action,
        ?string $entity = null,
        ?string $entityId = null,
        ?int $userId = null,
        array $payload = [],
        ?string $ip = null,
        ?string $userAgent = null,
    ): void {
        try {
            $db = Database::connect();
            $db->table('smoke_audit_logs')->insert([
                'user_id'      => $userId,
                'action'       => $action,
                'entity'       => $entity,
                'entity_id'    => $entityId,
                'ip'           => $ip,
                'user_agent'   => $userAgent ? mb_substr($userAgent, 0, 512) : null,
                'payload_json' => json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            ]);
        } catch (\Throwable $e) {
            log_message('error', 'AuditLogger.record failed: ' . $e->getMessage());
        }
    }
}
