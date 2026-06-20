<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Services;

/**
 * Generic brain invocation endpoint used by the worker (for in-task UX/feature-
 * gap enrichment) and by the portal for debugging. Authenticated via JWT +
 * RBAC at the route level, and via WorkerTokenFilter for the worker-callback
 * version under /worker/* (handled by WorkerController).
 */
class BrainController extends BaseController
{
    public function invoke(): ResponseInterface
    {
        $body = $this->jsonBody();
        $task = (string) ($body['task'] ?? 'plan');
        $sys  = (string) ($body['system_prompt'] ?? '');
        $usr  = (string) ($body['user_prompt']   ?? '');
        $ctx  = (array)  ($body['context']       ?? []);

        if ($sys === '' || $usr === '') {
            return $this->jsonError('invalid_request', 'system_prompt and user_prompt are required.', 400);
        }

        $result = Services::brain()->invoke($task, $sys, $usr, $ctx);
        return $this->jsonOk(['data' => $result]);
    }
}
