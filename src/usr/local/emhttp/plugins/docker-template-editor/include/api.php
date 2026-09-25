<?php
/*
 * Docker Template Editor - JSON API.
 *
 * GET  ?action=list | get&file= | backups&file= | backup&file=&id=
 * POST action=save | saveRaw | validate | bulk | recreate   (payload=<json>, csrf_token=...)
 *
 * Unraid's local_prepend.php enforces csrf_token on every POST before this runs.
 */
require_once __DIR__ . '/Templates.php';

header('Content-Type: application/json');

function reply($data, int $code = 200): void
{
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

$action = $_REQUEST['action'] ?? '';
$payload = [];
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $payload = json_decode($_POST['payload'] ?? '{}', true);
    if (!is_array($payload)) reply(['error' => 'Invalid payload'], 400);
}

try {
    switch ($action) {
        case 'list':
            reply(['templates' => DTE::listAll(), 'dir' => DTE::templateDir()]);

        case 'get':
            reply(DTE::load($_GET['file'] ?? ''));

        case 'backups':
            reply(['backups' => DTE::backups($_GET['file'] ?? '')]);

        case 'backup':
            reply(['xml' => DTE::readBackup($_GET['file'] ?? '', $_GET['id'] ?? '')]);

        case 'validate':
            reply(['problems' => DTE::validate($payload['fields'] ?? [], $payload['configs'] ?? [])]);

        case 'save':
            requirePost();
            $t = DTE::load($payload['file'] ?? '');
            $fields = $payload['fields'] ?? [];
            $configs = $payload['configs'] ?? [];
            $problems = DTE::validate($fields, $configs);
            if ($problems && empty($payload['force'])) reply(['problems' => $problems], 422);
            $xml = DTE::build($t['xml'], $fields, $configs);
            $res = DTE::write($t['file'], $xml, $payload['hash'] ?? null);
            reply($res + ['template' => DTE::load($t['file'])]);

        case 'saveRaw':
            requirePost();
            $t = DTE::load($payload['file'] ?? '');
            $res = DTE::write($t['file'], (string)($payload['xml'] ?? ''), $payload['hash'] ?? null);
            reply($res + ['template' => DTE::load($t['file'])]);

        case 'bulk':
            requirePost();
            reply(['results' => DTE::bulk((array)($payload['files'] ?? []), (array)($payload['op'] ?? []), !empty($payload['apply']))]);

        case 'recreate':
            requirePost();
            // Unraid's Docker manager includes define globals, so load them at global scope.
            $docroot ??= $_SERVER['DOCUMENT_ROOT'] ?: '/usr/local/emhttp';
            $dmInclude = "$docroot/plugins/dynamix.docker.manager/include";
            if (!is_file("$dmInclude/Helpers.php")) throw new RuntimeException('Unraid Docker manager not found.');
            $var ??= @parse_ini_file('/var/local/emhttp/var.ini') ?: [];
            require_once "$dmInclude/DockerClient.php";
            require_once "$dmInclude/Helpers.php";
            if (empty($driver) && class_exists('DockerUtil') && method_exists('DockerUtil', 'driver')) $driver = DockerUtil::driver();
            reply(recreate($payload['file'] ?? ''));

        default:
            reply(['error' => "Unknown action '$action'"], 400);
    }
} catch (Throwable $e) {
    reply(['error' => $e->getMessage()], 400);
}

function requirePost(): void
{
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') reply(['error' => 'POST required'], 405);
}

/**
 * Recreate the container from its saved template using Unraid's own
 * xmlToCommand(), the same routine the native "Apply" button uses.
 */
function recreate(string $file): array
{
    $path = DTE::path($file);
    if (!function_exists('xmlToCommand')) {
        throw new RuntimeException('This Unraid version does not expose xmlToCommand(); use "Apply in Unraid" instead.');
    }

    [$cmd, $name, $repository] = xmlToCommand($path);
    if (!$cmd || !$name) throw new RuntimeException('Could not build the docker command from the template.');

    $log = [];
    $run = function (string $c) use (&$log): int {
        $out = [];
        exec($c . ' 2>&1', $out, $rc);
        $log[] = '$ ' . $c;
        foreach ($out as $l) $log[] = $l;
        return $rc;
    };

    $q = escapeshellarg($name);
    exec("docker inspect -f '{{.State.Running}}' $q 2>/dev/null", $st, $exists);
    $wasRunning = $exists === 0 && trim($st[0] ?? '') === 'true';
    if ($exists === 0) {
        $timeout = max(0, (int)DTE::setting('STOP_TIMEOUT', '30'));
        if ($wasRunning) $run("docker stop -t $timeout $q");
        $run("docker rm -f $q");
    }
    // xmlToCommand builds a "docker create"; start it again only if it was running (or is new).
    $start = $wasRunning || $exists !== 0;
    if ($start) $cmd = preg_replace('#/docker create #', '/docker run -d ', $cmd, 1);
    $rc = $run($cmd);
    return ['ok' => $rc === 0, 'name' => $name, 'started' => $start && $rc === 0, 'log' => $log];
}
