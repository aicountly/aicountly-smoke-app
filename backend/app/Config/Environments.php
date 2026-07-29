<?php

namespace Config;

/**
 * Target environment safety tiers.
 *
 * Every tier that points at a live system is "production" for labelling, but
 * only the observer-only tiers strip destructive permission. `production_full_access`
 * is a live target the owner controls, so it keeps the production banner while
 * allowing the same actions as a sandbox.
 *
 * Never test a tier with str_starts_with($env, 'production') — that would sweep
 * production_full_access into the observer-only rules it is meant to opt out of.
 */
class Environments
{
    public const SANDBOX = 'sandbox';
    public const GH_STAGING = 'gh_staging';
    public const PRODUCTION_READONLY = 'production_readonly';
    public const PRODUCTION_RESTRICTED = 'production_restricted';
    public const PRODUCTION_FULL_ACCESS = 'production_full_access';

    /** @var list<string> */
    public const ALL = [
        self::SANDBOX,
        self::GH_STAGING,
        self::PRODUCTION_READONLY,
        self::PRODUCTION_RESTRICTED,
        self::PRODUCTION_FULL_ACCESS,
    ];

    /** Live targets, for banners and red badges. */
    private const PRODUCTION = [
        self::PRODUCTION_READONLY,
        self::PRODUCTION_RESTRICTED,
        self::PRODUCTION_FULL_ACCESS,
    ];

    /** Live targets that may never click a restricted label or touch files. */
    private const OBSERVER_ONLY = [
        self::PRODUCTION_READONLY,
        self::PRODUCTION_RESTRICTED,
    ];

    /** Tiers where destructive actions and file mutations may be opted into. */
    private const FULL_ACCESS = [
        self::SANDBOX,
        self::GH_STAGING,
        self::PRODUCTION_FULL_ACCESS,
    ];

    public static function isKnown(string $environment): bool
    {
        return in_array(self::normalize($environment), self::ALL, true);
    }

    public static function isProduction(string $environment): bool
    {
        return in_array(self::normalize($environment), self::PRODUCTION, true);
    }

    /**
     * True when the tier forces observer mode: read_only and observer_mode are
     * pinned on, allow_safe_demo and destructive_allowed are pinned off.
     */
    public static function isObserverOnly(string $environment): bool
    {
        return in_array(self::normalize($environment), self::OBSERVER_ONLY, true);
    }

    /** True when the tier may opt into destructive actions and file mutations. */
    public static function allowsFullAccess(string $environment): bool
    {
        return in_array(self::normalize($environment), self::FULL_ACCESS, true);
    }

    private static function normalize(string $environment): string
    {
        return strtolower(trim($environment));
    }
}
