<?php

namespace Tests\Unit;

use App\Services\ConsoleAccess\AccessDecision;
use App\Services\ConsoleAccess\ConsoleAccessPolicy;
use App\Services\ConsoleAccess\ConsoleRoleSyncService;
use App\Services\ConsoleAccess\ConsoleUserAccessClient;
use CodeIgniter\Test\CIUnitTestCase;
use Tests\Support\InMemoryUserRoleStore;
use Tests\Support\StubConsoleTransport;

/**
 * Console-assigned roles: login sync, refresh pull, Console-down window.
 * No database or network — the store and HTTP transport are fakes.
 *
 * @internal
 */
final class ConsoleRoleSyncTest extends CIUnitTestCase
{
    private const NOW = 1_800_000_000;

    private InMemoryUserRoleStore $store;

    protected function setUp(): void
    {
        parent::setUp();
        $this->store = new InMemoryUserRoleStore();
    }

    private function service(?StubConsoleTransport $transport = null, bool $configured = true): ConsoleRoleSyncService
    {
        $client = new ConsoleUserAccessClient(
            'https://console.test/api',
            $configured ? 'product-key' : '',
            'smoke',
            $transport ?? StubConsoleTransport::down(),
        );

        return new ConsoleRoleSyncService($this->store, $client, null, null, static fn (): int => self::NOW);
    }

    /** @return array<string,mixed> */
    private static function identity(array $extra = []): array
    {
        return array_merge([
            'active'            => true,
            'global_superadmin' => false,
            'user'              => ['id' => 42, 'name' => 'Asha', 'email' => 'asha@example.com', 'role' => 'staff'],
            'controller_grants' => [],
            'app_code'          => 'smoke',
        ], $extra);
    }

    // ---- login ------------------------------------------------------------

    public function testLoginWithAppRolesReplacesLocalRoles(): void
    {
        $this->store->roles[7] = ['owner', 'developer_viewer'];
        $sync     = $this->service();
        $decision = $sync->decideLogin(self::identity([
            'app_roles'       => ['product_reviewer'],
            'app_superadmin'  => false,
            'console_user_id' => 42,
            'authz_version'   => 9,
        ]));

        $this->assertTrue($decision->allowed);
        $this->assertSame(['product_reviewer'], $sync->applyLogin(7, $decision));
        $this->assertSame(['console_user_id' => 42, 'authz_version' => 9, 'roles_synced' => true], $this->store->links[7]);
    }

    public function testLoginIgnoresUnknownSlugs(): void
    {
        $sync     = $this->service();
        $decision = $sync->decideLogin(self::identity(['app_roles' => ['Product_Reviewer', 'qa_manager', 'auditor_viewer']]));

        $this->assertSame(['product_reviewer', 'auditor_viewer'], $sync->applyLogin(7, $decision));
    }

    public function testLoginWithEmptyAppRolesIsRefused(): void
    {
        $decision = $this->service()->decideLogin(self::identity(['app_roles' => [], 'app_superadmin' => false]));

        $this->assertFalse($decision->allowed);
        $this->assertSame(403, $decision->status);
        $this->assertSame('Access not assigned. Ask a Console superadmin to assign you a role.', $decision->message);
        $this->assertTrue($decision->revoke);
    }

    public function testLoginWithOnlyUnknownSlugsIsRefused(): void
    {
        $decision = $this->service()->decideLogin(self::identity(['app_roles' => ['qa_manager']]));

        $this->assertFalse($decision->allowed);
        $this->assertSame(ConsoleAccessPolicy::NOT_ASSIGNED_MESSAGE, $decision->message);
    }

    public function testSuperadminGetsEveryRoleIncludingOwner(): void
    {
        $sync     = $this->service();
        $decision = $sync->decideLogin(self::identity([
            'global_superadmin' => true,
            'app_superadmin'    => true,
            'app_roles'         => [],
        ]));

        $this->assertTrue($decision->allowed);
        $this->assertSame(['owner', 'product_reviewer', 'developer_viewer', 'auditor_viewer'], $sync->applyLogin(7, $decision));
    }

    public function testLegacyPayloadNeverGivesNonSuperadminTheTopRole(): void
    {
        $sync     = $this->service();
        $decision = $sync->decideLogin(self::identity()); // no app_roles key

        $this->assertTrue($decision->allowed);
        $this->assertSame(AccessDecision::SOURCE_LEGACY, $decision->source);
        $this->assertSame(['developer_viewer'], $sync->applyLogin(7, $decision));
        $this->assertFalse($this->store->links[7]['roles_synced']);
        $this->assertSame(42, $this->store->links[7]['console_user_id']);
    }

    public function testLegacyPayloadKeepsExistingRoles(): void
    {
        $this->store->roles[7] = ['product_reviewer'];
        $sync = $this->service();

        $this->assertSame(['product_reviewer'], $sync->applyLogin(7, $sync->decideLogin(self::identity())));
    }

    public function testLegacyPayloadSeedsOwnerOnlyForSuperadmin(): void
    {
        $sync = $this->service();

        $this->assertSame(['owner'], $sync->applyLogin(7, $sync->decideLogin(self::identity(['global_superadmin' => true]))));
    }

    // ---- refresh / re-check -------------------------------------------------

    /** @return array<string,mixed> */
    private static function user(?int $syncedAgo = 60): array
    {
        return [
            'id'              => 7,
            'email'           => 'asha@example.com',
            'console_user_id' => 42,
            'roles_synced_at' => $syncedAgo === null ? null : date('Y-m-d H:i:s', self::NOW - $syncedAgo),
        ];
    }

    public function testRefreshReplacesRolesWithConsoleAnswer(): void
    {
        $this->store->roles[7] = ['owner'];
        $transport = StubConsoleTransport::ok([
            'exists' => true, 'active' => true, 'app_access' => true, 'app_superadmin' => false,
            'console_user_id' => 42, 'email' => 'asha@example.com', 'name' => 'Asha',
            'app_roles' => ['developer_viewer'], 'authz_version' => 11,
        ]);

        $decision = $this->service($transport)->checkAccess(self::user(), true);

        $this->assertTrue($decision->allowed);
        $this->assertSame(['developer_viewer'], $this->store->roles[7]);
        $this->assertSame(11, $this->store->links[7]['authz_version']);
        $this->assertCount(1, $transport->calls);
        $this->assertSame(
            'https://console.test/api/portal/controller-apps/user-access?app_code=smoke&console_user_id=42',
            $transport->calls[0]['url'],
        );
        $this->assertContains('Authorization: Bearer product-key', $transport->calls[0]['headers']);
    }

    public function testRefreshUsesEmailWhenConsoleUserIdUnknown(): void
    {
        $transport = StubConsoleTransport::ok(['exists' => false]);
        $user      = self::user();
        $user['console_user_id'] = null;

        $this->service($transport)->checkAccess($user, true);

        $this->assertStringEndsWith('?app_code=smoke&email=asha%40example.com', $transport->calls[0]['url']);
    }

    public function testRefreshRevokedAccessIsRefusedAndSessionsRevoked(): void
    {
        $this->store->roles[7] = ['product_reviewer'];
        $transport = StubConsoleTransport::ok([
            'exists' => true, 'active' => true, 'app_access' => false, 'app_superadmin' => false,
            'app_roles' => [], 'authz_version' => 12,
        ]);

        $decision = $this->service($transport)->checkAccess(self::user(), true);

        $this->assertFalse($decision->allowed);
        $this->assertSame(403, $decision->status);
        $this->assertSame([7], $this->store->revoked);
        $this->assertSame([], $this->store->roles[7]);
    }

    public function testRefreshUnknownOrInactiveConsoleUserIsRevoked(): void
    {
        foreach ([['exists' => false], ['exists' => true, 'active' => false, 'app_access' => true, 'app_roles' => ['owner']]] as $data) {
            $this->store = new InMemoryUserRoleStore();
            $decision    = $this->service(StubConsoleTransport::ok($data))->checkAccess(self::user(), true);

            $this->assertFalse($decision->allowed);
            $this->assertSame([7], $this->store->revoked);
        }
    }

    public function testRefreshWithEmptyRolesIsRefused(): void
    {
        $transport = StubConsoleTransport::ok(['exists' => true, 'active' => true, 'app_access' => true, 'app_roles' => []]);

        $decision = $this->service($transport)->checkAccess(self::user(), true);

        $this->assertFalse($decision->allowed);
        $this->assertSame(ConsoleAccessPolicy::NOT_ASSIGNED_MESSAGE, $decision->message);
        $this->assertSame([7], $this->store->revoked);
    }

    public function testRefreshSuperadminGetsAllRoles(): void
    {
        $transport = StubConsoleTransport::ok(['exists' => true, 'active' => true, 'app_access' => true, 'app_superadmin' => true, 'app_roles' => ['owner']]);

        $this->assertTrue($this->service($transport)->checkAccess(self::user(), true)->allowed);
        $this->assertSame(['owner', 'product_reviewer', 'developer_viewer', 'auditor_viewer'], $this->store->roles[7]);
    }

    public function testRefreshConsoleDownWithin12HoursKeepsRoles(): void
    {
        $this->store->roles[7] = ['product_reviewer'];

        $decision = $this->service(StubConsoleTransport::down())->checkAccess(self::user(11 * 3600), true);

        $this->assertTrue($decision->allowed);
        $this->assertSame(AccessDecision::SOURCE_STALE, $decision->source);
        $this->assertNull($decision->roles);
        $this->assertSame(['product_reviewer'], $this->store->roles[7]);
        $this->assertSame([], $this->store->revoked);
    }

    public function testRefreshConsoleDownAfter12HoursIsRefusedWithoutRevoking(): void
    {
        $this->store->roles[7] = ['product_reviewer'];

        $decision = $this->service(StubConsoleTransport::down())->checkAccess(self::user(13 * 3600), true);

        $this->assertFalse($decision->allowed);
        $this->assertSame(401, $decision->status);
        $this->assertSame(ConsoleAccessPolicy::STALE_MESSAGE, $decision->message);
        $this->assertSame([], $this->store->revoked);
        $this->assertSame(['product_reviewer'], $this->store->roles[7]);
    }

    public function testRefreshConsoleDownAndNeverSyncedIsRefused(): void
    {
        $this->assertFalse($this->service(StubConsoleTransport::down())->checkAccess(self::user(null), true)->allowed);
    }

    public function testConsoleHttpErrorAndMalformedBodyCountAsUnreachable(): void
    {
        foreach ([
            new StubConsoleTransport(['status' => 500, 'body' => '{}']),
            new StubConsoleTransport(['status' => 200, 'body' => 'not json']),
            StubConsoleTransport::ok(['exists' => true, 'active' => true]), // no app_access/app_roles
        ] as $transport) {
            $decision = $this->service($transport)->checkAccess(self::user(13 * 3600), true);
            $this->assertFalse($decision->allowed);
            $this->assertSame(401, $decision->status);
            $this->assertSame([], $this->store->revoked);
        }
    }

    public function testUnconfiguredPullKeepsCurrentBehaviour(): void
    {
        $this->store->roles[7] = ['product_reviewer'];
        $transport = StubConsoleTransport::down();

        $decision = $this->service($transport, false)->checkAccess(self::user(null), true);

        $this->assertTrue($decision->allowed);
        $this->assertSame(AccessDecision::SOURCE_UNCONFIGURED, $decision->source);
        $this->assertSame([], $transport->calls);
        $this->assertSame(['product_reviewer'], $this->store->roles[7]);
    }

    public function testPerRequestCheckSkipsConsoleWhileRecentlySynced(): void
    {
        $transport = StubConsoleTransport::down();
        $sync      = $this->service($transport);

        $this->assertSame(AccessDecision::SOURCE_FRESH, $sync->checkAccess(self::user(60), false)->source);
        $this->assertSame([], $transport->calls);

        $sync->checkAccess(self::user(16 * 60), false);
        $this->assertCount(1, $transport->calls);
    }

    public function testSessionRevokedComparesTokenIssueTime(): void
    {
        $user = ['sessions_revoked_at' => date('Y-m-d H:i:s', self::NOW)];

        $this->assertTrue(ConsoleRoleSyncService::sessionRevoked($user, self::NOW - 1));
        $this->assertTrue(ConsoleRoleSyncService::sessionRevoked($user, self::NOW));
        $this->assertFalse(ConsoleRoleSyncService::sessionRevoked($user, self::NOW + 1));
        $this->assertFalse(ConsoleRoleSyncService::sessionRevoked(['sessions_revoked_at' => null], self::NOW - 1));
    }
}
