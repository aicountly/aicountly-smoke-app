<?php

namespace Tests\Database;

use App\Services\ConsoleAccess\ConsoleRoleSyncService;
use App\Services\ConsoleAccess\ConsoleUserAccessClient;
use App\Services\ConsoleAccess\DbUserRoleStore;
use App\Services\Auth\JwtService;
use App\Services\ConsoleIdentityService;
use CodeIgniter\Test\CIUnitTestCase;
use CodeIgniter\Test\DatabaseTestTrait;
use CodeIgniter\Test\FeatureTestTrait;
use CodeIgniter\Test\TestResponse;
use Config\Database;
use Config\Services;
use Tests\Support\StubConsoleTransport;
use Throwable;

/**
 * End-to-end over the real routes + PostgreSQL: Console SSO login and token
 * refresh apply Console-assigned roles. Console itself is stubbed (identity
 * service + user-access transport). Skipped when the CI4 "tests" database
 * connection is not reachable.
 *
 * @internal
 */
final class ConsoleSsoFeatureTest extends CIUnitTestCase
{
    use DatabaseTestTrait;
    use FeatureTestTrait;

    protected $DBGroup     = 'tests';
    protected $migrate     = true;
    protected $migrateOnce = true;
    protected $refresh     = false;
    protected $namespace   = 'App';

    /** @var array<string,mixed> */
    private array $identity = [];

    protected function setUp(): void
    {
        try {
            Database::connect('tests')->initialize();
        } catch (Throwable $e) {
            $this->markTestSkipped('CI4 "tests" database not reachable (set database.tests.*): ' . $e->getMessage());
        }

        parent::setUp();

        $this->db->query('TRUNCATE smoke_user_roles, smoke_users RESTART IDENTITY CASCADE');

        $test = $this;
        Services::injectMock('consoleIdentity', new class ($test) extends ConsoleIdentityService {
            public function __construct(private ConsoleSsoFeatureTest $test)
            {
            }

            public function exchangeLaunchToken(string $token): ?array
            {
                return $this->test->currentIdentity();
            }

            public function introspectSession(string $consoleToken): ?array
            {
                return $this->test->currentIdentity();
            }
        });
        $this->useConsole(null, false);
    }

    /** @return array<string,mixed> */
    public function currentIdentity(): array
    {
        return $this->identity;
    }

    private function useConsole(?StubConsoleTransport $transport, bool $configured = true): void
    {
        Services::injectMock('consoleRoleSync', new ConsoleRoleSyncService(
            new DbUserRoleStore($this->db),
            new ConsoleUserAccessClient('https://console.test/api', $configured ? 'product-key' : '', 'smoke', $transport ?? StubConsoleTransport::down()),
        ));
    }

    /** @param array<string,mixed> $extra */
    private function login(array $extra): TestResponse
    {
        $this->identity = array_merge([
            'active'            => true,
            'global_superadmin' => false,
            'user'              => ['id' => 42, 'name' => 'Asha', 'email' => 'asha@example.com', 'role' => 'staff'],
            'controller_grants' => [],
            'app_code'          => 'smoke',
        ], $extra);

        return $this->withBodyFormat('json')->post('v1/auth/controller-sso', ['token' => 'launch-token']);
    }

    /** @return array<string,mixed> */
    private static function json(TestResponse $r): array
    {
        return json_decode((string) $r->getJSON(), true) ?? [];
    }

    /** @return list<string> */
    private function localRoles(string $email = 'asha@example.com'): array
    {
        $rows = $this->db->query(
            'SELECT r.code FROM smoke_user_roles ur JOIN smoke_roles r ON r.id = ur.role_id JOIN smoke_users u ON u.id = ur.user_id WHERE u.email = ? ORDER BY r.id',
            [$email],
        )->getResultArray();

        return array_column($rows, 'code');
    }

    private function refreshWith(string $refreshToken): TestResponse
    {
        return $this->withBodyFormat('json')->post('v1/auth/refresh', ['refresh_token' => $refreshToken]);
    }

    public function testLoginWithAppRolesReplacesLocalRolesAndStoresConsoleLink(): void
    {
        $this->login(['app_roles' => ['owner'], 'console_user_id' => 42, 'authz_version' => 3])->assertStatus(200);
        $this->assertSame(['owner'], $this->localRoles());

        $r = $this->login(['app_roles' => ['product_reviewer'], 'console_user_id' => 42, 'authz_version' => 4]);
        $r->assertStatus(200);
        $this->assertSame(['product_reviewer'], self::json($r)['user']['roles']);
        $this->assertSame(['product_reviewer'], $this->localRoles());

        $user = $this->db->table('smoke_users')->where('email', 'asha@example.com')->get()->getRowArray();
        $this->assertSame(42, (int) $user['console_user_id']);
        $this->assertSame(4, (int) $user['authz_version']);
        $this->assertNotNull($user['roles_synced_at']);
    }

    public function testAccessTokensLiveAtMostFifteenMinutes(): void
    {
        $r = $this->login(['app_roles' => ['developer_viewer']]);
        $this->assertSame(JwtService::MAX_ACCESS_TTL, self::json($r)['expires_in']);
        $this->assertLessThanOrEqual(900, JwtService::MAX_ACCESS_TTL);
    }

    public function testLoginWithEmptyAppRolesIsRefused(): void
    {
        $this->login(['app_roles' => ['product_reviewer']])->assertStatus(200);

        $r = $this->login(['app_roles' => [], 'app_superadmin' => false]);
        $r->assertStatus(403);
        $this->assertSame('Access not assigned. Ask a Console superadmin to assign you a role.', self::json($r)['message']);
        $this->assertSame([], $this->localRoles());
    }

    public function testFirstLoginWithEmptyAppRolesCreatesNoUser(): void
    {
        $this->login(['app_roles' => []])->assertStatus(403);
        $this->assertSame(0, $this->db->table('smoke_users')->countAllResults());
    }

    public function testSuperadminGetsOwner(): void
    {
        $r = $this->login(['global_superadmin' => true, 'app_superadmin' => true, 'app_roles' => ['owner']]);
        $r->assertStatus(200);
        $this->assertContains('owner', self::json($r)['user']['roles']);
        $this->assertSame(['owner', 'product_reviewer', 'developer_viewer', 'auditor_viewer'], $this->localRoles());
    }

    public function testOldPayloadNeverGivesNonSuperadminTheTopRole(): void
    {
        $r = $this->login([]); // no app_roles key: old Console
        $r->assertStatus(200);
        $this->assertSame(['developer_viewer'], self::json($r)['user']['roles']);
    }

    public function testSsoCallbackShowsTheNotAssignedMessage(): void
    {
        $this->identity = [
            'active' => true, 'global_superadmin' => false, 'app_roles' => [],
            'user'   => ['id' => 42, 'name' => 'Asha', 'email' => 'asha@example.com'],
        ];

        $r = $this->get('v1/auth/sso-callback?token=launch-token');
        $r->assertStatus(403);
        $r->assertSee('Access not assigned. Ask a Console superadmin to assign you a role.');
    }

    public function testRefreshWithRevokedConsoleAccessIsRefusedAndEndsSessions(): void
    {
        $refresh = self::json($this->login(['app_roles' => ['product_reviewer'], 'console_user_id' => 42]))['refresh_token'];

        $this->useConsole(StubConsoleTransport::ok(['exists' => true, 'active' => true, 'app_access' => false, 'app_roles' => []]));
        $r = $this->refreshWith($refresh);
        $r->assertStatus(403);
        $this->assertSame('access_revoked', self::json($r)['error']);
        $this->assertSame([], $this->localRoles());

        // The same refresh token is dead even if Console would now say yes.
        $this->useConsole(StubConsoleTransport::ok(['exists' => true, 'active' => true, 'app_access' => true, 'app_roles' => ['owner']]));
        $this->refreshWith($refresh)->assertStatus(401);
    }

    public function testRefreshReplacesRolesFromConsole(): void
    {
        $refresh = self::json($this->login(['app_roles' => ['product_reviewer']]))['refresh_token'];

        $this->useConsole(StubConsoleTransport::ok(['exists' => true, 'active' => true, 'app_access' => true, 'app_roles' => ['auditor_viewer'], 'authz_version' => 8]));
        $r = $this->refreshWith($refresh);
        $r->assertStatus(200);
        $this->assertSame(['auditor_viewer'], self::json($r)['roles']);
        $this->assertSame(['auditor_viewer'], $this->localRoles());

        $me = $this->withHeaders(['Authorization' => 'Bearer ' . self::json($r)['access_token']])->get('v1/auth/me');
        $me->assertStatus(200);
        $this->assertSame(['auditor_viewer'], self::json($me)['roles']);
    }

    public function testRefreshWhileConsoleIsDownWithinAndAfter12Hours(): void
    {
        $refresh = self::json($this->login(['app_roles' => ['product_reviewer']]))['refresh_token'];
        $this->useConsole(StubConsoleTransport::down());

        $this->db->table('smoke_users')->update(['roles_synced_at' => date('Y-m-d H:i:s', time() - 11 * 3600)]);
        $this->refreshWith($refresh)->assertStatus(200);
        $this->assertSame(['product_reviewer'], $this->localRoles());

        $this->db->table('smoke_users')->update(['roles_synced_at' => date('Y-m-d H:i:s', time() - 13 * 3600)]);
        $r = $this->refreshWith($refresh);
        $r->assertStatus(401);
        $this->assertStringContainsString('more than 12 hours', self::json($r)['message']);
        $this->assertSame(['product_reviewer'], $this->localRoles());
    }

    public function testLocalRoleEditingIsReadOnly(): void
    {
        $access = self::json($this->login(['app_superadmin' => true, 'app_roles' => ['owner']]))['access_token'];
        $auth   = ['Authorization' => 'Bearer ' . $access];

        $r = $this->withHeaders($auth)->withBodyFormat('json')->post('v1/users/1/roles', ['role' => 'developer_viewer']);
        $r->assertStatus(403);
        $this->assertStringContainsString('Console → Roles & Access', self::json($r)['message']);

        $this->withHeaders($auth)->withBodyFormat('json')->put('v1/users/1', ['roles' => ['developer_viewer']])->assertStatus(403);

        $list = $this->withHeaders($auth)->get('v1/users');
        $list->assertStatus(200);
        $this->assertSame('console', self::json($list)['roles_managed_by']);

        // Deactivation stays local.
        $this->withHeaders($auth)->withBodyFormat('json')->put('v1/users/1', ['status' => 'disabled'])->assertStatus(200);
    }
}
