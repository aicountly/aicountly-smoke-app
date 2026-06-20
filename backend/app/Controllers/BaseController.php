<?php

namespace App\Controllers;

use CodeIgniter\Controller;
use CodeIgniter\HTTP\CLIRequest;
use CodeIgniter\HTTP\IncomingRequest;
use CodeIgniter\HTTP\RequestInterface;
use CodeIgniter\HTTP\ResponseInterface;
use Psr\Log\LoggerInterface;

abstract class BaseController extends Controller
{
    /** @var array<int,string> */
    protected $helpers = ['url', 'form', 'text'];

    /** @var CLIRequest|IncomingRequest */
    protected $request;

    public function initController(RequestInterface $request, ResponseInterface $response, LoggerInterface $logger): void
    {
        parent::initController($request, $response, $logger);
    }

    /**
     * Returns the authenticated user object stashed on the request by JwtAuthFilter.
     */
    protected function user(): ?object
    {
        return is_object($this->request->user ?? null) ? $this->request->user : null;
    }

    /** @return array<int,string> */
    protected function userRoles(): array
    {
        $u = $this->user();
        return $u ? array_map('strval', $u->roles ?? []) : [];
    }

    protected function jsonOk(array $data = [], int $status = 200): ResponseInterface
    {
        return $this->response->setStatusCode($status)->setJSON($data);
    }

    protected function jsonError(string $code, string $message, int $status = 400, array $extra = []): ResponseInterface
    {
        return $this->response->setStatusCode($status)->setJSON(array_merge([
            'error'   => $code,
            'message' => $message,
        ], $extra));
    }

    /** @return array<string,mixed> */
    protected function jsonBody(): array
    {
        $body = $this->request->getJSON(true);
        if (is_array($body)) {
            return $body;
        }
        return $this->request->getPost() ?: [];
    }
}
