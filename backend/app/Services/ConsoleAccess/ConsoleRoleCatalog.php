<?php

namespace App\Services\ConsoleAccess;

/**
 * The Smoke role slugs Console can assign (Console app_code `smoke`).
 *
 * Console is the source of truth for who holds which role; this catalog only
 * lists the slugs Smoke understands. They are identical to smoke_roles.code,
 * which RbacFilter and the SPA check.
 */
final class ConsoleRoleCatalog
{
    public const OWNER            = 'owner';
    public const PRODUCT_REVIEWER = 'product_reviewer';
    public const DEVELOPER_VIEWER = 'developer_viewer';
    public const AUDITOR_VIEWER   = 'auditor_viewer';

    /** Slug => local role code (smoke_roles.code). */
    public const SLUG_TO_CODE = [
        self::OWNER            => 'owner',
        self::PRODUCT_REVIEWER => 'product_reviewer',
        self::DEVELOPER_VIEWER => 'developer_viewer',
        self::AUDITOR_VIEWER   => 'auditor_viewer',
    ];

    /**
     * Role given to a non-superadmin on first sign-in while Console still runs
     * the old payload (no `app_roles`). Never the top role.
     */
    public const LEGACY_DEFAULT = self::DEVELOPER_VIEWER;

    /** @return list<string> */
    public function all(): array
    {
        return array_keys(self::SLUG_TO_CODE);
    }

    public function owner(): string
    {
        return self::OWNER;
    }

    public function legacyDefault(): string
    {
        return self::LEGACY_DEFAULT;
    }

    /**
     * Keep only known slugs, lower-cased, de-duplicated, in catalog order.
     *
     * @param mixed $slugs
     * @return list<string>
     */
    public function normalize(mixed $slugs): array
    {
        if (! is_array($slugs)) {
            return [];
        }

        $wanted = [];
        foreach ($slugs as $slug) {
            if (! is_string($slug)) {
                continue;
            }
            $wanted[strtolower(trim($slug))] = true;
        }

        return array_values(array_filter($this->all(), static fn (string $s): bool => isset($wanted[$s])));
    }
}
