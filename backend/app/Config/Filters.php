<?php

namespace Config;

use App\Filters\AuditFilter;
use App\Filters\CorsFilter;
use App\Filters\JwtAuthFilter;
use App\Filters\ProductionGuardFilter;
use App\Filters\RbacFilter;
use App\Filters\WorkerTokenFilter;
use CodeIgniter\Config\BaseConfig;
use CodeIgniter\Filters\Cors;
use CodeIgniter\Filters\CSRF;
use CodeIgniter\Filters\DebugToolbar;
use CodeIgniter\Filters\ForceHTTPS;
use CodeIgniter\Filters\Honeypot;
use CodeIgniter\Filters\InvalidChars;
use CodeIgniter\Filters\PageCache;
use CodeIgniter\Filters\PerformanceMetrics;
use CodeIgniter\Filters\SecureHeaders;

class Filters extends BaseConfig
{
    public array $aliases = [
        'csrf'          => CSRF::class,
        'toolbar'       => DebugToolbar::class,
        'honeypot'      => Honeypot::class,
        'invalidchars'  => InvalidChars::class,
        'secureheaders' => SecureHeaders::class,
        'cors'          => CorsFilter::class,
        'forcehttps'    => ForceHTTPS::class,
        'pagecache'     => PageCache::class,
        'performance'   => PerformanceMetrics::class,

        // Smoke filters
        'jwt'              => JwtAuthFilter::class,
        'rbac'             => RbacFilter::class,
        'audit'            => AuditFilter::class,
        'worker_token'     => WorkerTokenFilter::class,
        'production_guard' => ProductionGuardFilter::class,
    ];

    public array $required = [
        'before' => ['cors'],
        'after'  => ['cors', 'toolbar'],
    ];

    public array $globals = [
        'before' => [
            'invalidchars',
            'audit',
        ],
        'after' => [
            'audit',
        ],
    ];

    public array $methods = [];

    public array $filters = [];
}
