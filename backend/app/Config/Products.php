<?php

namespace Config;

/**
 * Canonical AICOUNTLY SaaS product catalog (my.aicountly.com suite).
 *
 * Excludes legacy / non-SaaS slugs: sandbox, gh-books, gh-hrms, erp, erp-beta.
 */
class Products
{
    /** @var list<array{slug:string,label:string}> */
    public const CATALOG = [
        ['slug' => 'contacts',     'label' => 'Contacts'],
        ['slug' => 'my-account',   'label' => 'My Account'],
        ['slug' => 'books',        'label' => 'Smart Books'],
        ['slug' => 'calendar',     'label' => 'Calendar'],
        ['slug' => 'docs',         'label' => 'Docs'],
        ['slug' => 'chat',         'label' => 'Chat'],
        ['slug' => 'auditor',      'label' => 'Auditor'],
        ['slug' => 'fr',           'label' => 'Financial Reporting'],
        ['slug' => 'secretarial',  'label' => 'Secretarial'],
        ['slug' => 'vault',        'label' => 'Vault'],
        ['slug' => 'hrms',         'label' => 'HRMS'],
    ];

    /** @return list<string> */
    public static function slugs(): array
    {
        return array_column(self::CATALOG, 'slug');
    }
}
