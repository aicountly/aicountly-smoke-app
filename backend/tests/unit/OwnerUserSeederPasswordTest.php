<?php

namespace Tests\Unit;

use App\Database\Seeds\OwnerUserSeeder;
use CodeIgniter\Test\CIUnitTestCase;

/**
 * The seeded owner never gets a password that is written in this (public) repository.
 *
 * @internal
 */
final class OwnerUserSeederPasswordTest extends CIUnitTestCase
{
    protected function tearDown(): void
    {
        putenv('SMOKE_OWNER_PASSWORD');
        parent::tearDown();
    }

    public function testWithoutConfigurationTheInitialPasswordIsRandom(): void
    {
        putenv('SMOKE_OWNER_PASSWORD');

        $a = OwnerUserSeeder::initialPassword();
        $b = OwnerUserSeeder::initialPassword();

        $this->assertSame(48, strlen($a));
        $this->assertNotSame($a, $b);
    }

    public function testAConfiguredPasswordOfTwelveOrMoreCharactersIsUsed(): void
    {
        putenv('SMOKE_OWNER_PASSWORD=a-long-operator-secret');

        $this->assertSame('a-long-operator-secret', OwnerUserSeeder::initialPassword());
    }

    public function testAShortConfiguredPasswordIsIgnored(): void
    {
        putenv('SMOKE_OWNER_PASSWORD=short');

        $this->assertNotSame('short', OwnerUserSeeder::initialPassword());
    }

    public function testTheSeederSourceHoldsNoLiteralPassword(): void
    {
        $src = (string) file_get_contents(APPPATH . 'Database/Seeds/OwnerUserSeeder.php');

        $this->assertDoesNotMatchRegularExpression("/password_hash\\(\\s*'[^']+'/", $src);
    }
}
