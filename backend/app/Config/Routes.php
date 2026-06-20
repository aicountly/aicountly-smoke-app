<?php

use CodeIgniter\Router\RouteCollection;

/** @var RouteCollection $routes */

$routes->get('/', 'HealthController::index');
$routes->get('health', 'HealthController::index');

$routes->group('v1', static function (RouteCollection $routes): void {
    // ---- Auth (public + authenticated) -----------------------------------
    $routes->post('auth/login',          'AuthController::login');
    $routes->post('auth/refresh',        'AuthController::refresh');
    $routes->group('auth', ['filter' => 'jwt'], static function (RouteCollection $routes): void {
        $routes->post('logout',         'AuthController::logout');
        $routes->get('me',              'AuthController::me');
        $routes->post('change-password','AuthController::changePassword');
    });

    // ---- Worker callback (shared-token auth, separate filter) ------------
    $routes->group('worker', ['filter' => 'worker_token'], static function (RouteCollection $routes): void {
        $routes->post('lease',                 'WorkerController::lease');
        $routes->post('jobs/(:num)/heartbeat', 'WorkerController::heartbeat/$1');
        $routes->post('jobs/(:num)/complete',  'WorkerController::complete/$1');
        $routes->post('jobs/(:num)/fail',      'WorkerController::fail/$1');
        $routes->post('credentials/(:num)/decrypt', 'WorkerController::decryptCredential/$1');
        $routes->post('results',               'WorkerController::recordResult');
        $routes->post('inventory',             'WorkerController::recordInventory');
        $routes->post('ux-issues',             'WorkerController::recordUxIssue');
        $routes->post('feature-gaps',          'WorkerController::recordFeatureGap');
        $routes->post('reports',               'WorkerController::recordReport');
        $routes->post('runs/(:num)/finalize',  'WorkerController::finalizeRun/$1');
    });

    // ---- All other endpoints require JWT ---------------------------------
    $routes->group('', ['filter' => 'jwt'], static function (RouteCollection $routes): void {
        // Dashboard
        $routes->get('dashboard',                'DashboardController::summary');

        // Users (owner-only)
        $routes->get('users',                    'UsersController::index',  ['filter' => 'rbac:owner']);
        $routes->post('users',                   'UsersController::create', ['filter' => 'rbac:owner']);
        $routes->put('users/(:num)',             'UsersController::update/$1', ['filter' => 'rbac:owner']);
        $routes->delete('users/(:num)',          'UsersController::delete/$1', ['filter' => 'rbac:owner']);
        $routes->post('users/(:num)/roles',      'UsersController::assignRole/$1', ['filter' => 'rbac:owner']);

        // Target profiles
        $routes->get('target-profiles',          'TargetProfilesController::index');
        $routes->get('target-profiles/(:num)',   'TargetProfilesController::show/$1');
        $routes->post('target-profiles',         'TargetProfilesController::create', ['filter' => 'rbac:owner,product_reviewer']);
        $routes->put('target-profiles/(:num)',   'TargetProfilesController::update/$1', ['filter' => 'rbac:owner,product_reviewer']);
        $routes->delete('target-profiles/(:num)','TargetProfilesController::delete/$1', ['filter' => 'rbac:owner']);

        // Credential vault
        $routes->post('target-profiles/(:num)/credentials',  'CredentialsController::store/$1',  ['filter' => 'rbac:owner,product_reviewer']);
        $routes->put('target-profiles/(:num)/credentials',   'CredentialsController::rotate/$1', ['filter' => 'rbac:owner,product_reviewer']);

        // Master prompts + planning
        $routes->post('master-prompts',          'MasterPromptsController::create', ['filter' => 'rbac:owner,product_reviewer']);
        $routes->get('master-prompts/(:num)',    'MasterPromptsController::show/$1');

        // Session plans
        $routes->get('session-plans/(:num)',     'SessionPlansController::show/$1');
        $routes->put('session-plans/(:num)',     'SessionPlansController::update/$1', ['filter' => 'rbac:owner,product_reviewer']);
        $routes->post('session-plans/(:num)/sessions',  'SessionPlansController::addSession/$1',     ['filter' => 'rbac:owner,product_reviewer']);
        $routes->put('session-plans/(:num)/reorder',    'SessionPlansController::reorder/$1',        ['filter' => 'rbac:owner,product_reviewer']);
        $routes->post('session-plans/(:num)/approve',   'SessionPlansController::approve/$1',        ['filter' => 'rbac:owner,product_reviewer']);
        $routes->post('session-plans/(:num)/reject',    'SessionPlansController::reject/$1',         ['filter' => 'rbac:owner,product_reviewer']);
        $routes->post('session-plans/(:num)/run',       'SessionPlansController::startRun/$1',       ['filter' => 'rbac:owner,product_reviewer']);

        // Sessions (within plan)
        $routes->put('sessions/(:num)',          'SessionsController::update/$1',  ['filter' => 'rbac:owner,product_reviewer']);
        $routes->post('sessions/(:num)/split',   'SessionsController::split/$1',   ['filter' => 'rbac:owner,product_reviewer']);
        $routes->post('sessions/(:num)/merge',   'SessionsController::merge/$1',   ['filter' => 'rbac:owner,product_reviewer']);
        $routes->delete('sessions/(:num)',       'SessionsController::delete/$1',  ['filter' => 'rbac:owner,product_reviewer']);

        // Observation runs
        $routes->get('runs',                     'ObservationRunsController::index');
        $routes->get('runs/(:num)',              'ObservationRunsController::show/$1');
        $routes->get('runs/code/(:segment)',     'ObservationRunsController::showByCode/$1');
        $routes->post('runs/(:num)/cancel',      'ObservationRunsController::cancel/$1', ['filter' => 'rbac:owner,product_reviewer']);

        // Reports
        $routes->get('reports',                  'ReportsController::index');
        $routes->get('reports/(:num)',           'ReportsController::show/$1');
        $routes->get('reports/(:num)/html',      'ReportsController::html/$1');
        $routes->get('reports/(:num)/json',      'ReportsController::json/$1');
        $routes->get('reports/(:num)/files',     'ReportsController::files/$1');

        // UI inventory / UX / feature gaps
        $routes->get('runs/(:num)/inventory',    'UiInventoryController::index/$1');
        $routes->get('runs/(:num)/ux-issues',    'UxIssuesController::index/$1');
        $routes->get('runs/(:num)/feature-gaps', 'FeatureGapsController::index/$1');
        $routes->get('feature-gap-matrix',       'FeatureGapsController::matrix');

        // Competitor profiles
        $routes->get('competitors',              'CompetitorProfilesController::index');
        $routes->post('competitors',             'CompetitorProfilesController::create', ['filter' => 'rbac:owner,product_reviewer']);
        $routes->put('competitors/(:num)',       'CompetitorProfilesController::update/$1', ['filter' => 'rbac:owner,product_reviewer']);
        $routes->delete('competitors/(:num)',    'CompetitorProfilesController::delete/$1', ['filter' => 'rbac:owner']);

        // Settings
        $routes->get('settings',                 'SettingsController::index', ['filter' => 'rbac:owner,product_reviewer']);
        $routes->put('settings/(:any)',          'SettingsController::update/$1', ['filter' => 'rbac:owner']);

        // Audit logs
        $routes->get('audit-logs',               'AuditLogsController::index', ['filter' => 'rbac:owner,product_reviewer,auditor_viewer']);

        // Brain (for the worker / debugging)
        $routes->post('brain/invoke',            'BrainController::invoke', ['filter' => 'rbac:owner,product_reviewer']);
    });
});
