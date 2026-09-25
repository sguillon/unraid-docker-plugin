<?php
/*
 * Local development harness: emulates just enough of the Unraid webGui to run
 * the plugin pages against a scratch copy of dev/fixtures.
 *
 *   ./dev/serve.sh   ->  http://localhost:8765/            (Docker → Templates tab)
 *                        http://localhost:8765/?page=settings
 *                        add &theme=black for the dark theme, &ace=0 to emulate Unraid 6.12 (no Ace)
 */
$docroot = realpath(__DIR__ . '/../src/usr/local/emhttp');
$plugin = "$docroot/plugins/docker-template-editor";
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

if (str_starts_with($uri, '/plugins/docker-template-editor/')) {
    $file = realpath($plugin . substr($uri, strlen('/plugins/docker-template-editor')));
    if (!$file || !str_starts_with($file, $plugin)) { http_response_code(404); exit; }
    if (str_ends_with($file, '.php')) { require $file; exit; }
    $types = ['js' => 'application/javascript', 'css' => 'text/css'];
    header('Content-Type: ' . ($types[pathinfo($file, PATHINFO_EXTENSION)] ?? 'application/octet-stream'));
    readfile($file);
    exit;
}

if (str_starts_with($uri, '/webGui/javascript/ace/')) {
    $file = getenv('DTE_DEV_ACE_DIR') . '/' . basename($uri);
    if (!is_file($file)) { http_response_code(404); exit; }
    header('Content-Type: application/javascript');
    readfile($file);
    exit;
}

if ($uri === '/update.php') {
    // Unraid writes every non-# field of the form into the cfg file named by #file.
    $lines = [];
    foreach ($_POST as $k => $v) if ($k[0] !== '#') $lines[] = $k . '="' . addcslashes($v, '"') . '"';
    file_put_contents(getenv('DTE_CONFIG_FILE'), implode("\n", $lines) . "\n");
    echo '<script>parent.location.reload()</script>';
    exit;
}

if (str_starts_with($uri, '/Docker/UpdateContainer')) {
    echo '<p>(Unraid native editor would open here for ' . htmlspecialchars($_GET['xmlTemplate'] ?? '') . ')</p>';
    exit;
}

// Render a .page file like emhttp does: strip the header, run the PHP body.
function autov($p) { echo $p . '?v=' . time(); }
$theme = ($_GET['theme'] ?? 'white') === 'black' ? 'black' : 'white';
$display = ['theme' => $theme];
$var = ['csrf_token' => 'dev-token', 'fsState' => 'Started'];
if (($_GET['ace'] ?? '1') === '1') putenv('DTE_ACE_PATH=/webGui/javascript/ace');
$pageFile = ($_GET['page'] ?? '') === 'settings' ? 'DockerTemplateEditorSettings.page' : 'DockerTemplateEditor.page';
[$header, $body] = explode("\n---\n", file_get_contents("$plugin/$pageFile"), 2);
preg_match('/^Title="([^"]*)"/m', $header, $m);
$colors = $theme === 'black' ? 'background:#1c1b1b;color:#f2f2f2' : 'background:#f2f2f2;color:#222';
?><!doctype html><html><head><meta charset="utf-8"><title><?=$m[1]?> (dev)</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/css/font-awesome.min.css">
<style>html{font-size:62.5%}body{font-family:clear-sans,Arial,sans-serif;margin:0;font-size:1.3rem;<?=$colors?>}
#displaybox{padding:20px 30px} .title{font-size:1.8rem;margin-bottom:10px} .dim{opacity:.6}
dl{display:grid;grid-template-columns:300px 1fr;margin:8px 0} dt{text-align:right;padding-right:12px} dd{margin:0}
.harness a{color:inherit;margin-right:12px}</style></head>
<body><div id="displaybox">
<div class="title"><?=$m[1]?> <small class="harness">(dev harness —
  <a href="/?theme=<?=$theme?>">Templates tab</a><a href="/?page=settings&theme=<?=$theme?>">Settings</a>
  <a href="?<?=http_build_query(['theme' => $theme === 'black' ? 'white' : 'black'] + $_GET)?>">toggle theme</a>)</small></div>
<?php eval('?>' . $body); ?>
</div><iframe name="progressFrame" hidden></iframe>
<script>function done(){ location.href='/'; }</script></body></html>
