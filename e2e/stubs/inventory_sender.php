<?php
declare(strict_types=1);

/**
 * A stand-in for Inventory's outbox (Inventory is not in this stack): it delivers Inventory-style events
 * to Smart Books' machine route POST integration/inventory/events exactly as Inventory does — X-Service-Key
 * plus X-Inventory-Signature (Books' InventoryInboundAuthenticator canonical string) — and follows the
 * sender rule every AICOUNTLY outbox follows, using the company-lifecycle kit's own DeferredSend (the
 * canonical copy in manage-aicountly "Saas Common Handler/company-lifecycle", which Inventory vendors):
 *
 *   423 COMPANY_RESTRICTED  -> deferred_restricted (no attempt spent), next_check_at, restricted_until
 *   deferred, re-check due  -> DeferredSend::review() asks Manage internal/company-status?app=books
 *                              (Bearer MANAGE_PRODUCT_SERVICE_KEY): resume -> pending | wait | drop
 *   2xx                     -> delivered
 *
 * The outbox is a JSON file (--state). Commands (one JSON line on stdout):
 *
 *   php inventory_sender.php --kit=<kit dir> --state=<file> enqueue --cmp=<id> --type=<event_type> [--payload=<json>]
 *   php inventory_sender.php --kit=<kit dir> --state=<file> run [--recheck-now]
 *
 * --recheck-now treats every deferred item's next_check_at as due (the hour is simulated, as the scenarios
 * move time). Environment: BOOKS_API_BASE (…/api), INVENTORY_INBOUND_SERVICE_KEY, INVENTORY_INBOUND_SIGNING_SECRET,
 * MANAGE_API_URL, MANAGE_PRODUCT_SERVICE_KEY.
 */
if (PHP_SAPI !== 'cli') {
    exit(1);
}

$opt = [];
$cmd = null;
foreach (array_slice($argv, 1) as $a) {
    if (preg_match('/^--([a-z-]+)(?:=(.*))?$/s', $a, $m) === 1) {
        $opt[$m[1]] = $m[2] ?? true;
    } else {
        $cmd = $a;
    }
}
require rtrim((string) ($opt['kit'] ?? ''), '/') . '/autoload.php';

use Aicountly\Lifecycle\Config;
use Aicountly\Lifecycle\DeferredSend;
use Aicountly\Lifecycle\Http;

$statePath = (string) ($opt['state'] ?? '');
$state = is_file($statePath) ? (json_decode((string) file_get_contents($statePath), true) ?: []) : [];
$state += ['events' => [], 'log' => []];
$save = static function () use (&$state, $statePath): void {
    file_put_contents($statePath, json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
};

if ($cmd === 'enqueue') {
    $cmp = (int) ($opt['cmp'] ?? 0);
    $payload = isset($opt['payload']) ? (json_decode((string) $opt['payload'], true) ?: []) : [];
    $id = bin2hex(random_bytes(16));
    $state['events'][] = [
        'event_id' => substr($id, 0, 8) . '-' . substr($id, 8, 4) . '-4' . substr($id, 13, 3) . '-a' . substr($id, 17, 3) . '-' . substr($id, 20, 12),
        'event_type' => (string) ($opt['type'] ?? 'inventory.uom.upserted'),
        'cmp_id' => $cmp, 'payload' => $payload + ['cmp_id' => $cmp],
        'status' => 'pending', 'attempts' => 0, 'restricted_until' => null, 'next_check_at' => null, 'last_http' => null, 'reason' => null,
    ];
    $save();
    echo json_encode(['enqueued' => end($state['events'])], JSON_UNESCAPED_SLASHES), "\n";
    exit(0);
}
if ($cmd !== 'run') {
    fwrite(STDERR, "usage: enqueue | run\n");
    exit(2);
}

$env = static fn (string $k): string => trim((string) (getenv($k) ?: ''));
$books = rtrim($env('BOOKS_API_BASE'), '/');
$key = $env('INVENTORY_INBOUND_SERVICE_KEY');
$secret = $env('INVENTORY_INBOUND_SIGNING_SECRET');
$config = Config::fromEnv('inventory');
$deferred = new DeferredSend($config);
$now = time();
$out = ['reviewed' => [], 'sent' => []];

// 1. Deferred items whose re-check is due: ask Manage (DeferredSend::review), per company.
$reviewedCmp = [];
foreach ($state['events'] as &$e) {
    if ($e['status'] !== DeferredSend::DEFERRED_RESTRICTED) {
        continue;
    }
    if (!isset($opt['recheck-now']) && (int) $e['next_check_at'] > $now) {
        continue;
    }
    $d = $reviewedCmp[$e['cmp_id']] ??= $deferred->review((int) $e['cmp_id'], 'books', $e['restricted_until']);
    $out['reviewed'][] = ['event_id' => $e['event_id'], 'cmp_id' => $e['cmp_id']] + $d;
    if ($d['action'] === 'resume') {
        $e['status'] = 'pending';
        $e['reason'] = $d['reason'];
    } elseif ($d['action'] === 'drop') {
        $e['status'] = DeferredSend::DROPPED_COMPANY_DELETED;
        $e['reason'] = $d['reason'];
        $state['log'][] = ['at' => gmdate('c', $now), 'event_id' => $e['event_id'], 'audit' => 'inventory_event.dropped_company_deleted', 'reason' => $d['reason']];
    } else {
        $e['next_check_at'] = $d['next_check_at'];
        $e['restricted_until'] = $d['restricted_until'];
    }
}
unset($e);

// 2. Deliver pending items, one company batch per request (as Inventory's outbox does).
$byCmp = [];
foreach ($state['events'] as $i => $e) {
    if ($e['status'] === 'pending') {
        $byCmp[$e['cmp_id']][] = $i;
    }
}
foreach ($byCmp as $cmp => $idx) {
    $batch = ['events' => array_map(static fn (int $i): array => [
        'event_id' => $state['events'][$i]['event_id'], 'event_type' => $state['events'][$i]['event_type'],
        'cmp_id' => $state['events'][$i]['cmp_id'], 'payload' => $state['events'][$i]['payload'],
    ], $idx)];
    $raw = (string) json_encode($batch, JSON_UNESCAPED_SLASHES);
    $t = time();
    $canonical = "POST\nintegration/inventory/events\n\n" . hash('sha256', $raw);
    $sig = 't=' . $t . ',v1=' . hash_hmac('sha256', $t . '.' . $canonical, $secret);
    $res = Http::request('POST', $books . '/integration/inventory/events',
        ['Content-Type: application/json', 'Accept: application/json', 'X-Service-Key: ' . $key, 'X-Inventory-Signature: ' . $sig], $raw, 30);
    $status = (int) ($res['status'] ?? 0);
    $c = DeferredSend::classify($status, (string) ($res['body'] ?? ''), $t);
    $out['sent'][] = ['cmp_id' => $cmp, 'http' => $status, 'action' => $c['action'], 'body' => json_decode((string) ($res['body'] ?? ''), true)];
    foreach ($idx as $i) {
        $e = &$state['events'][$i];
        $e['last_http'] = $status;
        if ($c['action'] === 'deliver') {
            $e['status'] = 'delivered';
        } elseif ($c['action'] === 'defer') {
            // deferred, not failed: no attempt spent
            $e['status'] = DeferredSend::DEFERRED_RESTRICTED;
            $e['restricted_until'] = $c['restricted_until'];
            $e['next_check_at'] = $c['next_check_at'];
            $e['reason'] = $c['reason'];
        } elseif ($c['action'] === 'drop') {
            $e['status'] = DeferredSend::DROPPED_COMPANY_DELETED;
            $e['reason'] = $c['reason'];
            $state['log'][] = ['at' => gmdate('c', $t), 'event_id' => $e['event_id'], 'audit' => 'inventory_event.dropped_company_deleted', 'reason' => $c['reason']];
        } else {
            $e['attempts']++;
            $e['reason'] = $c['reason'];
        }
        unset($e);
    }
}
$save();
$out['events'] = $state['events'];
echo json_encode($out, JSON_UNESCAPED_SLASHES), "\n";
exit(0);
