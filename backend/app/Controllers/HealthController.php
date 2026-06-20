<?php

namespace App\Controllers;

use CodeIgniter\HTTP\ResponseInterface;

class HealthController extends BaseController
{
    public function index(): ResponseInterface
    {
        return $this->jsonOk([
            'service' => 'smoke.aicountly.org',
            'status'  => 'ok',
            'version' => '0.1.0',
            'time'    => date(DATE_ATOM),
        ]);
    }
}
