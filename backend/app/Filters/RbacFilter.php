<?php

namespace App\Filters;

use CodeIgniter\Filters\FilterInterface;
use CodeIgniter\HTTP\RequestInterface;
use CodeIgniter\HTTP\ResponseInterface;

/**
 * Gates a route by required role codes. Usage:
 *   ['filter' => 'rbac:owner,product_reviewer']
 *
 * The user is read from $request->user (set by JwtAuthFilter). At least one of
 * the listed roles must be present, otherwise responds with 403.
 */
class RbacFilter implements FilterInterface
{
    public function before(RequestInterface $request, $arguments = null)
    {
        $required = is_array($arguments) ? $arguments : [];
        if ($required === []) {
            return; // no constraint
        }
        $user = $request->user ?? null;
        if (! is_object($user) || empty($user->id)) {
            return service('response')->setStatusCode(401)->setJSON([
                'error'   => 'unauthorized',
                'message' => 'Authentication required',
            ]);
        }
        $userRoles = array_map('strval', $user->roles ?? []);
        foreach ($required as $role) {
            if (in_array($role, $userRoles, true)) {
                return; // ok
            }
        }
        return service('response')->setStatusCode(403)->setJSON([
            'error'    => 'forbidden',
            'message'  => 'Insufficient role',
            'required' => $required,
            'have'     => $userRoles,
        ]);
    }

    public function after(RequestInterface $request, ResponseInterface $response, $arguments = null)
    {
        // no-op
    }
}
