<?php

namespace Config;

use App\Services\Audit\AuditLogger;
use App\Services\Auth\JwtService;
use App\Services\Auth\RbacService;
use App\Services\Brain\BrainEnsemble;
use App\Services\Brain\Adapters\DeterministicAdapter;
use App\Services\Brain\Adapters\GeminiAdapter;
use App\Services\Brain\Adapters\OpenAIAdapter;
use App\Services\Brain\Adapters\PerplexityAdapter;
use App\Services\Planner\SessionPlanner;
use App\Services\Reports\FinalReportBuilder;
use App\Services\Reports\SessionReportBuilder;
use App\Services\Runner\RunOrchestrator;
use App\Services\Search\PerplexitySearchAdapter;
use App\Services\Vault\CredentialVault;
use CodeIgniter\Config\BaseService;

class Services extends BaseService
{
    public static function jwt(bool $getShared = true): JwtService
    {
        if ($getShared) {
            return self::getSharedInstance('jwt');
        }
        return new JwtService();
    }

    public static function rbac(bool $getShared = true): RbacService
    {
        if ($getShared) {
            return self::getSharedInstance('rbac');
        }
        return new RbacService();
    }

    public static function audit(bool $getShared = true): AuditLogger
    {
        if ($getShared) {
            return self::getSharedInstance('audit');
        }
        return new AuditLogger();
    }

    public static function vault(bool $getShared = true): CredentialVault
    {
        if ($getShared) {
            return self::getSharedInstance('vault');
        }
        return new CredentialVault();
    }

    public static function brain(bool $getShared = true): BrainEnsemble
    {
        if ($getShared) {
            return self::getSharedInstance('brain');
        }
        return new BrainEnsemble(
            new OpenAIAdapter(),
            new PerplexityAdapter(),
            new GeminiAdapter(),
            new DeterministicAdapter(),
        );
    }

    public static function planner(bool $getShared = true): SessionPlanner
    {
        if ($getShared) {
            return self::getSharedInstance('planner');
        }
        return new SessionPlanner(self::brain());
    }

    public static function runner(bool $getShared = true): RunOrchestrator
    {
        if ($getShared) {
            return self::getSharedInstance('runner');
        }
        return new RunOrchestrator();
    }

    public static function sessionReport(bool $getShared = true): SessionReportBuilder
    {
        if ($getShared) {
            return self::getSharedInstance('sessionReport');
        }
        return new SessionReportBuilder();
    }

    public static function finalReport(bool $getShared = true): FinalReportBuilder
    {
        if ($getShared) {
            return self::getSharedInstance('finalReport');
        }
        return new FinalReportBuilder();
    }

    public static function searchAdapter(bool $getShared = true): PerplexitySearchAdapter
    {
        if ($getShared) {
            return self::getSharedInstance('searchAdapter');
        }
        return new PerplexitySearchAdapter();
    }
}
