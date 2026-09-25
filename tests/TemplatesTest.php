<?php
/* Plain PHP tests for include/Templates.php.  Run: php tests/TemplatesTest.php */
$work = sys_get_temp_dir() . '/dte-test-' . getmypid();
putenv("DTE_TEMPLATE_DIR=$work/templates");
putenv("DTE_BACKUP_DIR=$work/backups");
putenv("DTE_CONFIG_FILE=$work/test.cfg");
mkdir("$work/templates", 0777, true);
file_put_contents("$work/test.cfg", "BACKUP_RETENTION=\"3\"\n");
foreach (glob(__DIR__ . '/../dev/fixtures/*.xml') as $f) copy($f, "$work/templates/" . basename($f));
require __DIR__ . '/../src/usr/local/emhttp/plugins/docker-template-editor/include/Templates.php';

$failures = 0;
function check(string $name, bool $ok, string $detail = ''): void
{
    global $failures;
    echo ($ok ? "  ok   " : "  FAIL ") . $name . ($ok || $detail === '' ? '' : "\n       $detail") . "\n";
    if (!$ok) $failures++;
}
function throws(callable $fn): bool { try { $fn(); return false; } catch (Throwable $e) { return true; } }

echo "parse\n";
$t = DTE::load('my-plex.xml');
check('reads simple fields', $t['fields']['Name'] === 'plex' && $t['fields']['Network'] === 'host');
check('decodes entities', str_contains($t['fields']['Overview'], '& streams'));
check('reads all configs', count($t['configs']) === 11);
check('config attrs + value', $t['configs'][6]['attrs']['Target'] === 'PLEX_CLAIM' && $t['configs'][6]['value'] === 'claim-abc123');
check('empty elements are fields', array_key_exists('PostArgs', $t['fields']) && $t['fields']['PostArgs'] === '');
check('legacy detected', DTE::load('my-legacy.xml')['legacy'] === true && $t['legacy'] === false);

echo "round trip\n";
$same = DTE::build($t['xml'], $t['fields'], $t['configs']);
check('no-op build keeps all data', DTE::parse($same)['configs'] == $t['configs'] && DTE::parse($same)['fields'] == $t['fields']);
check('trailing non-Config element kept in place', strpos($same, '<TailscaleEnabled>') > strrpos($same, '<Config '));
check('xml header like dockerMan', str_starts_with($same, '<?xml version="1.0"?>'));

echo "edit\n";
$fields = $t['fields']; $fields['Network'] = 'br0'; $fields['NewField'] = 'x';
$configs = $t['configs'];
$configs[2]['value'] = '1000';
$configs[] = ['attrs' => DTE::newConfigAttrs('Variable', 'TZ'), 'value' => 'Europe/Paris & <co>'];
array_splice($configs, 7, 1); // drop NVIDIA_VISIBLE_DEVICES
$xml = DTE::build($t['xml'], $fields, $configs);
$p = DTE::parse($xml);
check('field updated', $p['fields']['Network'] === 'br0');
check('new field added', $p['fields']['NewField'] === 'x');
check('value updated', $p['configs'][2]['value'] === '1000');
check('config removed', !str_contains($xml, 'NVIDIA_VISIBLE_DEVICES'));
check('special chars escaped and restored', end($p['configs'])['value'] === 'Europe/Paris & <co>');
check('attribute order matches dockerMan', str_contains($xml, '<Config Name="TZ" Target="TZ" Default="" Mode="" Description="" Type="Variable" Display="always" Required="false" Mask="false">'));
$noShell = $fields; unset($noShell['Shell']);
check('dropped field removed', !str_contains(DTE::build($t['xml'], $noShell, $configs), '<Shell>'));
check('rejects bad field name', throws(fn() => DTE::build($t['xml'], ['bad name' => 1], [])));
check('rejects bad attribute name', throws(fn() => DTE::build($t['xml'], [], [['attrs' => ['a b' => 1], 'value' => '']])));

echo "validate\n";
check('clean template valid', DTE::validate($t['fields'], $t['configs']) === [], implode('; ', DTE::validate($t['fields'], $t['configs'])));
$bad = $t['configs'];
$bad[] = ['attrs' => DTE::newConfigAttrs('Variable', 'PUID'), 'value' => '1'];
$bad[] = ['attrs' => DTE::newConfigAttrs('Variable', 'HAS SPACE'), 'value' => '1'];
$bad[] = ['attrs' => DTE::newConfigAttrs('Port', 'abc'), 'value' => '1'];
$bad[] = ['attrs' => DTE::newConfigAttrs('Path', 'relative'), 'value' => '1'];
$bad[0]['value'] = '';
$problems = DTE::validate(['Name' => 'bad name!', 'Repository' => ''], $bad);
check('finds 7 problems', count($problems) === 7, implode("\n       ", $problems));

echo "write + backups\n";
$r = DTE::write('my-plex.xml', $xml, $t['hash']);
check('write reports change', $r['changed'] === true);
check('backup created', count(DTE::backups('my-plex.xml')) === 1);
check('backup holds old content', DTE::readBackup('my-plex.xml', DTE::backups('my-plex.xml')[0]['id']) === $t['xml']);
check('stale hash rejected', throws(fn() => DTE::write('my-plex.xml', $t['xml'], $t['hash'])));
check('identical write is a no-op', DTE::write('my-plex.xml', $xml, sha1($xml))['changed'] === false);
check('invalid xml rejected', throws(fn() => DTE::write('my-plex.xml', '<Container><oops></Container>')));
check('path traversal rejected', throws(fn() => DTE::path('../../etc/passwd')) && throws(fn() => DTE::path('my-../x.xml/..')) && throws(fn() => DTE::readBackup('my-plex.xml', '../x.xml')));

echo "settings\n";
check('user cfg overrides default.cfg', DTE::setting('BACKUP_RETENTION') === '3' && DTE::setting('AFTER_SAVE') === 'ask');
for ($i = 0; $i < 5; $i++) {
    $cur = DTE::load('my-sonarr.xml');
    DTE::write('my-sonarr.xml', str_replace('</Container>', "<!-- $i --></Container>", $cur['xml']), $cur['hash']);
}
check('backup retention honoured', count(DTE::backups('my-sonarr.xml')) === 3);

echo "bulk\n";
$preview = DTE::bulk(['my-plex.xml', 'my-sonarr.xml'], ['kind' => 'replace', 'find' => '/mnt/cache/appdata', 'replace' => '/mnt/user/appdata', 'types' => ['Path']], false);
check('replace preview finds both', count($preview[0]['changes']) === 1 && count($preview[1]['changes']) === 1);
check('preview does not write', str_contains(file_get_contents("$work/templates/my-sonarr.xml"), '/mnt/cache/appdata'));
DTE::bulk(['my-plex.xml', 'my-sonarr.xml'], ['kind' => 'replace', 'find' => '/mnt/cache/appdata', 'replace' => '/mnt/user/appdata'], true);
check('replace applied', str_contains(file_get_contents("$work/templates/my-sonarr.xml"), '/mnt/user/appdata/sonarr'));
$r = DTE::bulk(['my-plex.xml', 'my-sonarr.xml'], ['kind' => 'setvar', 'key' => 'TZ', 'value' => 'Europe/Paris', 'add' => true], true);
check('setvar updates + adds', $r[0]['changes'][0]['new'] === 'Europe/Paris' && $r[1]['changes'][0]['old'] === 'America/New_York');
$r = DTE::bulk(['my-sonarr.xml'], ['kind' => 'setvar', 'key' => 'NEWVAR', 'value' => '1', 'add' => false], false);
check('setvar without add leaves missing alone', $r[0]['changes'] === []);
$r = DTE::bulk(['my-plex.xml'], ['kind' => 'replace', 'find' => '^(\d+)$', 'replace' => 'n$1', 'regex' => true, 'types' => ['Variable']], false);
check('regex replace', count($r[0]['changes']) === 3, json_encode($r[0]['changes']));
check('bad regex rejected', throws(fn() => DTE::bulk(['my-plex.xml'], ['kind' => 'replace', 'find' => '(', 'regex' => true], false)));
DTE::bulk(['my-sonarr.xml'], ['kind' => 'delvar', 'key' => 'TZ'], true);
check('delvar removes', !str_contains(file_get_contents("$work/templates/my-sonarr.xml"), 'Target="TZ"'));
check('legacy skipped', isset(DTE::bulk(['my-legacy.xml'], ['kind' => 'delvar', 'key' => 'X'], true)[0]['skipped']));

echo "list\n";
$list = DTE::listAll();
check('lists 3 templates', count($list) === 3);
check('counts types', $list[1]['name'] === 'plex' && $list[1]['counts']['Path'] === 2);

exec('rm -rf ' . escapeshellarg($work));
echo $failures ? "\n$failures FAILED\n" : "\nall passed\n";
exit($failures ? 1 : 0);
