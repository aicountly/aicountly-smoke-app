<?php

namespace App\Filters;

use CodeIgniter\Filters\FilterInterface;
use CodeIgniter\HTTP\RequestInterface;
use CodeIgniter\HTTP\ResponseInterface;

class CorsFilter implements FilterInterface
{
    public function before(RequestInterface $request, $arguments = null)
    {
        $origin = $request->getHeaderLine('Origin');
        $allowed = $this->allowedOrigins();

        if ($origin !== '' && in_array($origin, $allowed, true)) {
            $response = service('response');
            $response->setHeader('Access-Control-Allow-Origin', $origin);
            $response->setHeader('Vary', 'Origin');
            $response->setHeader('Access-Control-Allow-Credentials', 'true');
            $response->setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Worker-Token, X-Requested-With');
            $response->setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            $response->setHeader('Access-Control-Max-Age', '600');

            if (strtoupper($request->getMethod()) === 'OPTIONS') {
                $response->setStatusCode(204);
                return $response;
            }
        }
    }

    public function after(RequestInterface $request, ResponseInterface $response, $arguments = null)
    {
        $origin = $request->getHeaderLine('Origin');
        if ($origin !== '' && in_array($origin, $this->allowedOrigins(), true)) {
            $response->setHeader('Access-Control-Allow-Origin', $origin);
            $response->setHeader('Vary', 'Origin');
        }
    }

    /** @return string[] */
    private function allowedOrigins(): array
    {
        $raw = env('CORS_ALLOW_ORIGINS', 'http://localhost:5173');
        return array_values(array_filter(array_map('trim', explode(',', (string) $raw))));
    }
}
