<?php

namespace App\Filters;

use CodeIgniter\Filters\FilterInterface;
use CodeIgniter\HTTP\RequestInterface;
use CodeIgniter\HTTP\ResponseInterface;

/**
 * Refuses risky operations against production target profiles unless the
 * authenticated user is an Owner AND the request body explicitly opts in via
 * `confirm_production=true`. Apply this filter to mutating routes that may
 * touch production targets (e.g. starting a run with destructive_allowed).
 */
class ProductionGuardFilter implements FilterInterface
{
    public function before(RequestInterface $request, $arguments = null)
    {
        $body = $request->getJSON(true) ?? $request->getPost();
        $confirm = (bool) ($body['confirm_production'] ?? false);
        $allowDestructive = (bool) ($body['destructive_allowed'] ?? false);
        if (! $allowDestructive) {
            return; // observer-mode requests are always allowed
        }
        $user = $request->user ?? null;
        $roles = is_object($user) ? ($user->roles ?? []) : [];
        if (! in_array('owner', $roles, true) || ! $confirm) {
            return service('response')->setStatusCode(403)->setJSON([
                'error'   => 'production_guard',
                'message' => 'Destructive action against production requires Owner role and explicit confirm_production=true.',
            ]);
        }
    }

    public function after(RequestInterface $request, ResponseInterface $response, $arguments = null)
    {
        // no-op
    }
}
