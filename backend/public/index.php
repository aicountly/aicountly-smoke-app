<?php

/**
 * Front controller for smoke.aicountly.org backend.
 */

define('FCPATH', __DIR__ . DIRECTORY_SEPARATOR);

$pathsConfig = realpath(__DIR__ . '/../app/Config/Paths.php');
if ($pathsConfig === false || ! is_file($pathsConfig)) {
    header('Content-Type: text/plain; charset=UTF-8');
    http_response_code(500);
    echo "Paths config missing.\n";
    exit;
}

require $pathsConfig;
$paths = new Config\Paths();

$bootstrap = rtrim($paths->systemDirectory, '\\/ ') . DIRECTORY_SEPARATOR . 'bootstrap.php';
if (! is_file($bootstrap)) {
    header('Content-Type: text/plain; charset=UTF-8');
    http_response_code(500);
    echo "CodeIgniter bootstrap missing. Run `composer install` in backend/.\n";
    exit;
}

$app = require $bootstrap;
$app->run();
