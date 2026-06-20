<?php

namespace App\Filters;

use CodeIgniter\Filters\FilterInterface;
use CodeIgniter\HTTP\RequestInterface;
use CodeIgniter\HTTP\ResponseInterface;
use Config\Services;
use Throwable;

/**
 * Verifies a Bearer JWT and attaches the decoded user context onto the request.
 */
class JwtAuthFilter implements FilterInterface
{
    public function before(RequestInterface $request, $arguments = null)
    {
        $auth = $request->getHeaderLine('Authorization');
        if ($auth === '') {
            // Apache/CGI often drops Authorization before PHP; .htaccess sets this env var.
            $auth = (string) ($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');
        }
        if ($auth === '' || stripos($auth, 'Bearer ') !== 0) {
            return $this->unauthorized('Missing bearer token');
        }
        $token = trim(substr($auth, 7));
        if ($token === '') {
            return $this->unauthorized('Empty bearer token');
        }

        try {
            $payload = Services::jwt()->verifyAccess($token);
        } catch (Throwable $e) {
            return $this->unauthorized('Invalid token: ' . $e->getMessage());
        }

        // Stash on the request for controllers / downstream filters
        $request->user = (object) [
            'id'    => (int) ($payload->sub ?? 0),
            'email' => (string) ($payload->email ?? ''),
            'roles' => (array) ($payload->roles ?? []),
        ];
    }

    public function after(RequestInterface $request, ResponseInterface $response, $arguments = null)
    {
        // no-op
    }

    private function unauthorized(string $message): ResponseInterface
    {
        return service('response')
            ->setStatusCode(401)
            ->setJSON(['error' => 'unauthorized', 'message' => $message]);
    }
}
