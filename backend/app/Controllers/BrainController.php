<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;
use Config\Services;

/**
 * Portal/debug brain invocation (JWT + RBAC).
 * Worker enrichment uses POST /worker/brain/invoke (WorkerController::brainInvoke).
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
