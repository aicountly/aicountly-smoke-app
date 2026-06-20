<?php

namespace App\Filters;

use CodeIgniter\Filters\FilterInterface;
use CodeIgniter\HTTP\RequestInterface;
use CodeIgniter\HTTP\ResponseInterface;

/**
 * Authenticates the Playwright worker by a shared token sent in
 * `X-Worker-Token`. Constant-time compare; no JWT here.
 */
class WorkerTokenFilter implements FilterInterface
{
    public function before(RequestInterface $request, $arguments = null)
    {
        $expected = (string) env('WORKER_SHARED_TOKEN', '');
        $given    = trim($request->getHeaderLine('X-Worker-Token'));
        if ($expected === '' || $given === '' || ! hash_equals($expected, $given)) {
            return service('response')->setStatusCode(401)->setJSON([
                'error'   => 'unauthorized',
                'message' => 'Worker token invalid',
            ]);
        }
    }

    public function after(RequestInterface $request, ResponseInterface $response, $arguments = null)
    {
        // no-op
    }
}
