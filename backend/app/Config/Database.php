<?php

namespace Config;

use CodeIgniter\Database\Config;

class Database extends Config
{
    public string $filesPath = APPPATH . 'Database' . DIRECTORY_SEPARATOR;

    public string $defaultGroup = 'default';

    public array $default = [
        'DSN'        => '',
        'hostname'   => '127.0.0.1',
        'port'       => 5432,
        'username'   => 'smoke_user',
        'password'   => 'change_me',
        'database'   => 'smoke_aicountly',
        'DBDriver'   => 'Postgre',
        'DBPrefix'   => '',
        'pConnect'   => false,
        'DBDebug'    => true,
        'charset'    => 'utf8',
        'swapPre'    => '',
        'encrypt'    => false,
        'compress'   => false,
        'strictOn'   => false,
        'failover'   => [],
        'schema'     => 'public',
        'sslmode'    => '',
        'connect_timeout' => 10,
    ];

    public array $tests = [
        'DSN'        => '',
        'hostname'   => '127.0.0.1',
        'port'       => 5432,
        'username'   => 'smoke_user',
        'password'   => 'change_me',
        'database'   => 'smoke_aicountly_test',
        'DBDriver'   => 'Postgre',
        'DBPrefix'   => '',
        'pConnect'   => false,
        'DBDebug'    => true,
        'charset'    => 'utf8',
        'swapPre'    => '',
        'encrypt'    => false,
        'compress'   => false,
        'strictOn'   => false,
        'failover'   => [],
        'schema'     => 'public',
        'sslmode'    => '',
        'connect_timeout' => 10,
    ];

    public function __construct()
    {
        parent::__construct();

        if (ENVIRONMENT === 'testing') {
            $this->defaultGroup = 'tests';
        }
    }
}
