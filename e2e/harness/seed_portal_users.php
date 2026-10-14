<?php

declare(strict_types=1);

/**
 * Create customer accounts in the portal's user tables (useraictly / uuidgenert / useraicdet — the
 * DB_UUID_* connection). Nothing else: sessions are minted afterwards through the REAL portal
 * (POST /api/auth/login, then POST /api/seskey). Adapted from console-react-app
 * ops/harness/lib/seed_portal_users.php. Passwords are stored the way the portal checks them
 * (AppCommonModel::login -> password_verify), i.e. password_hash(PASSWORD_DEFAULT).
 *
 *   php seed_portal_users.php <pg-dsn> <db-user> <db-pass>   < users.json
 *   users.json: [{"uuid":201,"first":"..","last":"..","email":"..","mobile":"..","password":".."}, ...]
 */

[$self, $dsn, $user, $pass] = $argv + [null, null, null, null];
$users = json_decode((string) stream_get_contents(STDIN), true);
if (!$dsn || !is_array($users)) {
    fwrite(STDERR, "usage: seed_portal_users.php <dsn> <user> <pass> < users.json\n");
    exit(2);
}

$pdo = new PDO($dsn, $user, (string) $pass, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$cols = static function (string $table) use ($pdo): array {
    $st = $pdo->prepare("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ?");
    $st->execute([$table]);
    return array_flip($st->fetchAll(PDO::FETCH_COLUMN));
};
$insert = static function (string $table, array $row) use ($pdo): void {
    $pdo->prepare('INSERT INTO ' . $table . ' (' . implode(',', array_keys($row)) . ') VALUES (' . implode(',', array_fill(0, count($row), '?')) . ')')
        ->execute(array_values($row));
};
$uc = $cols('useraictly');
$gc = $cols('uuidgenert');
$dc = $cols('useraicdet');

$pdo->beginTransaction();
foreach ($users as $u) {
    foreach (['useraicdet', 'useraictly', 'uuidgenert'] as $t) {
        $pdo->prepare("DELETE FROM $t WHERE uuid = ?")->execute([$u['uuid']]);
    }
    if ($gc !== []) {
        $insert('uuidgenert', array_intersect_key(['uuid' => $u['uuid'], 'uuid_regdemail' => $u['email'], 'uuid_regdmobile' => $u['mobile']], $gc));
    }
    $insert('useraictly', array_intersect_key([
        'uuid'                    => $u['uuid'],
        'user_firstname'          => $u['first'],
        'user_lastname'           => $u['last'],
        'user_name'               => strtolower($u['first']) . '_' . $u['uuid'],
        'user_pass'               => password_hash($u['password'], PASSWORD_DEFAULT),
        'user_regdemail'          => $u['email'],
        'user_regdmobile'         => $u['mobile'],
        'useraictly_status'       => 1,
        'registered_at'           => date('Y-m-d H:i:s'),
        'platform_account_status' => null,
    ], $uc));
    if ($dc !== []) {
        $insert('useraicdet', ['uuid' => $u['uuid']]);
    }
}
$pdo->exec("SELECT setval(pg_get_serial_sequence('uuidgenert', 'uuid'), GREATEST((SELECT MAX(uuid) FROM uuidgenert), 1000))");
$pdo->commit();
echo json_encode(['seeded' => count($users)]), "\n";
