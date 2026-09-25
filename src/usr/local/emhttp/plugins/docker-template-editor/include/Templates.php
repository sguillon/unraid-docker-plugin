<?php
/*
 * Docker Template Editor - template storage and XML (de)serialisation.
 *
 * Reads and writes the dockerMan user templates (my-*.xml) that Unraid uses to
 * (re)create containers. Everything that is not a <Config> entry or a simple
 * text element is preserved untouched when saving.
 */

class DTE
{
    const PLUGIN = 'docker-template-editor';

    private static ?array $config = null;

    /** Known <Config> attributes, in the order dockerMan writes them. */
    const CONFIG_ATTRS = ['Name', 'Target', 'Default', 'Mode', 'Description', 'Type', 'Display', 'Required', 'Mask'];

    /** Plugin settings: default.cfg overlaid with the user's cfg on the flash drive. */
    public static function config(): array
    {
        if (self::$config === null) {
            $defaults = @parse_ini_file(dirname(__DIR__) . '/default.cfg') ?: [];
            $user = getenv('DTE_CONFIG_FILE') ?: '/boot/config/plugins/' . self::PLUGIN . '/' . self::PLUGIN . '.cfg';
            self::$config = array_merge($defaults, (is_file($user) ? @parse_ini_file($user) : false) ?: []);
        }
        return self::$config;
    }

    public static function setting(string $key, string $fallback = ''): string
    {
        return (string)(self::config()[$key] ?? $fallback);
    }

    public static function templateDir(): string
    {
        return rtrim(getenv('DTE_TEMPLATE_DIR') ?: '/boot/config/plugins/dockerMan/templates-user', '/');
    }

    public static function backupDir(): string
    {
        return rtrim(getenv('DTE_BACKUP_DIR') ?: '/boot/config/plugins/' . self::PLUGIN . '/backups', '/');
    }

    /** Resolve a template file name to an absolute path, rejecting anything outside the template dir. */
    public static function path(string $file): string
    {
        $file = basename($file);
        if (!preg_match('/^my-[^\/\\\\]+\.xml$/', $file)) {
            throw new InvalidArgumentException("Invalid template name: $file");
        }
        return self::templateDir() . '/' . $file;
    }

    /** @return array<int, array> summary of every user template */
    public static function listAll(): array
    {
        $states = self::containerStates();
        $out = [];
        foreach (glob(self::templateDir() . '/my-*.xml') ?: [] as $path) {
            $row = ['file' => basename($path), 'mtime' => filemtime($path)];
            try {
                $t = self::load(basename($path));
                $name = $t['fields']['Name'] ?? substr(basename($path, '.xml'), 3);
                $counts = [];
                foreach ($t['configs'] as $c) {
                    $type = $c['attrs']['Type'] ?? 'Variable';
                    $counts[$type] = ($counts[$type] ?? 0) + 1;
                }
                $row += [
                    'name' => $name,
                    'repository' => $t['fields']['Repository'] ?? '',
                    'icon' => $t['fields']['Icon'] ?? '',
                    'network' => $t['fields']['Network'] ?? '',
                    'counts' => $counts,
                    'state' => $states[$name] ?? 'not created',
                    'legacy' => $t['legacy'],
                ];
            } catch (Throwable $e) {
                $row += ['name' => basename($path), 'error' => $e->getMessage(), 'state' => 'unknown', 'counts' => []];
            }
            $out[] = $row;
        }
        usort($out, fn($a, $b) => strcasecmp($a['name'], $b['name']));
        return $out;
    }

    /** @return array<string,string> container name => state */
    public static function containerStates(): array
    {
        $states = [];
        if (!is_executable('/usr/bin/docker') && !is_executable('/usr/local/bin/docker')) return $states;
        exec("docker ps -a --format '{{.Names}}\t{{.State}}' 2>/dev/null", $lines);
        foreach ($lines as $line) {
            [$n, $s] = array_pad(explode("\t", $line, 2), 2, '');
            $states[$n] = $s;
        }
        return $states;
    }

    public static function load(string $file): array
    {
        $path = self::path($file);
        if (!is_file($path)) throw new RuntimeException("Template not found: $file");
        $raw = file_get_contents($path);
        $model = self::parse($raw);
        $model['file'] = basename($path);
        $model['hash'] = sha1($raw);
        $model['mtime'] = filemtime($path);
        return $model;
    }

    public static function loadDom(string $xml): DOMDocument
    {
        $dom = new DOMDocument('1.0', 'UTF-8');
        $dom->preserveWhiteSpace = false;
        $dom->formatOutput = true;
        libxml_use_internal_errors(true);
        $ok = $dom->loadXML($xml, LIBXML_NONET);
        $errors = libxml_get_errors();
        libxml_clear_errors();
        if (!$ok || !$dom->documentElement) {
            $msg = $errors ? trim($errors[0]->message) . ' (line ' . $errors[0]->line . ')' : 'unknown error';
            throw new RuntimeException("Invalid XML: $msg");
        }
        if ($dom->documentElement->nodeName !== 'Container') {
            throw new RuntimeException('Root element must be <Container>');
        }
        return $dom;
    }

    /**
     * Turn template XML into the editor model:
     *  fields  - simple text children (Name, Repository, Network, ...) in document order
     *  configs - <Config> entries: attrs + value
     *  legacy  - true for pre-version-2 templates (edit as raw XML only)
     */
    public static function parse(string $xml): array
    {
        $dom = self::loadDom($xml);
        $root = $dom->documentElement;
        $fields = [];
        $configs = [];
        $complex = [];
        foreach ($root->childNodes as $node) {
            if (!($node instanceof DOMElement)) continue;
            if ($node->nodeName === 'Config') {
                $attrs = [];
                foreach ($node->attributes as $a) $attrs[$a->name] = $a->value;
                $configs[] = ['attrs' => $attrs, 'value' => $node->textContent];
            } elseif (self::isSimple($node)) {
                $fields[$node->nodeName] = $node->textContent;
            } else {
                $complex[] = $node->nodeName;
            }
        }
        $version = $root->getAttribute('version');
        return [
            'version' => $version,
            'legacy' => $version !== '2' && in_array('Environment', $complex, true),
            'fields' => $fields,
            'configs' => $configs,
            'complex' => $complex,
            'xml' => $xml,
        ];
    }

    private static function isSimple(DOMElement $node): bool
    {
        foreach ($node->childNodes as $c) {
            if ($c instanceof DOMElement) return false;
        }
        return true;
    }

    /** Apply an editor model (fields + configs) onto existing XML and return the new XML. */
    public static function build(string $originalXml, array $fields, array $configs): string
    {
        $dom = self::loadDom($originalXml);
        $root = $dom->documentElement;

        // Simple fields: update in place, append new ones before the first <Config>.
        $existing = [];
        foreach (iterator_to_array($root->childNodes) as $node) {
            if ($node instanceof DOMElement && $node->nodeName !== 'Config' && self::isSimple($node)) {
                $existing[$node->nodeName] = $node;
            }
        }
        $firstConfig = null;
        foreach ($root->childNodes as $node) {
            if ($node instanceof DOMElement && $node->nodeName === 'Config') { $firstConfig = $node; break; }
        }
        foreach ($fields as $tag => $value) {
            $tag = (string)$tag;
            if (!preg_match('/^[A-Za-z_][A-Za-z0-9_.-]*$/', $tag) || $tag === 'Config') {
                throw new InvalidArgumentException("Invalid field name: $tag");
            }
            $value = (string)$value;
            if (isset($existing[$tag])) {
                $el = $existing[$tag];
                while ($el->firstChild) $el->removeChild($el->firstChild);
                if ($value !== '') $el->appendChild($dom->createTextNode($value));
                unset($existing[$tag]);
            } else {
                $el = $dom->createElement($tag);
                if ($value !== '') $el->appendChild($dom->createTextNode($value));
                $firstConfig ? $root->insertBefore($el, $firstConfig) : $root->appendChild($el);
            }
        }
        // Simple fields the editor dropped are removed.
        foreach ($existing as $el) $root->removeChild($el);

        // Replace all <Config> entries, keeping them where the first one was.
        $anchor = null;
        foreach (iterator_to_array($root->childNodes) as $node) {
            if ($node instanceof DOMElement && $node->nodeName === 'Config') {
                $anchor = $node->nextSibling;
                $root->removeChild($node);
            }
        }
        if ($anchor && $anchor->parentNode !== $root) $anchor = null;
        foreach ($configs as $i => $c) {
            $attrs = (array)($c['attrs'] ?? []);
            $el = $dom->createElement('Config');
            foreach (self::CONFIG_ATTRS as $a) {
                if (array_key_exists($a, $attrs)) $el->setAttribute($a, (string)$attrs[$a]);
            }
            foreach ($attrs as $a => $v) {
                if (in_array($a, self::CONFIG_ATTRS, true)) continue;
                if (!preg_match('/^[A-Za-z_][A-Za-z0-9_.-]*$/', (string)$a)) {
                    throw new InvalidArgumentException("Invalid attribute name on config #" . ($i + 1));
                }
                $el->setAttribute($a, (string)$v);
            }
            $value = (string)($c['value'] ?? '');
            if ($value !== '') $el->appendChild($dom->createTextNode($value));
            $anchor ? $root->insertBefore($el, $anchor) : $root->appendChild($el);
        }

        return self::serialize($dom);
    }

    private static function serialize(DOMDocument $dom): string
    {
        // Re-load so formatOutput re-indents nodes we created.
        $clean = new DOMDocument('1.0', 'UTF-8');
        $clean->preserveWhiteSpace = false;
        $clean->formatOutput = true;
        $clean->loadXML($dom->saveXML());
        $xml = $clean->saveXML();
        return str_replace('<?xml version="1.0" encoding="UTF-8"?>', '<?xml version="1.0"?>', $xml);
    }

    /** Validate a model and return a list of human readable problems (empty = ok). */
    public static function validate(array $fields, array $configs): array
    {
        $problems = [];
        if (trim((string)($fields['Name'] ?? '')) === '') $problems[] = 'Container name is empty.';
        elseif (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/', $fields['Name'])) $problems[] = 'Container name contains invalid characters.';
        if (trim((string)($fields['Repository'] ?? '')) === '') $problems[] = 'Repository is empty.';
        $seen = [];
        foreach ($configs as $i => $c) {
            $a = $c['attrs'] ?? [];
            $type = $a['Type'] ?? '';
            $target = trim((string)($a['Target'] ?? ''));
            $label = ($a['Name'] ?? '') !== '' ? $a['Name'] : "#" . ($i + 1);
            if (!in_array($type, ['Variable', 'Path', 'Port', 'Label', 'Device'], true)) {
                $problems[] = "\"$label\": unknown type \"$type\".";
            }
            if ($target === '' && $type !== 'Device') $problems[] = "\"$label\": key/target is empty.";
            if ($type === 'Variable' && $target !== '' && !preg_match('/^[^=\s]+$/', $target)) {
                $problems[] = "\"$label\": variable key \"$target\" must not contain spaces or '='.";
            }
            if ($type === 'Port' && $target !== '' && !ctype_digit($target)) $problems[] = "\"$label\": container port \"$target\" is not a number.";
            if ($type === 'Path' && $target !== '' && $target[0] !== '/') $problems[] = "\"$label\": container path \"$target\" must be absolute.";
            if (($a['Required'] ?? '') === 'true' && trim((string)($c['value'] ?? '')) === '') $problems[] = "\"$label\" is required but empty.";
            if ($target !== '' && in_array($type, ['Variable', 'Path', 'Label'], true)) {
                $k = $type . ':' . $target;
                if (isset($seen[$k])) $problems[] = "Duplicate $type \"$target\".";
                $seen[$k] = true;
            }
        }
        return $problems;
    }

    /**
     * Write new XML for a template. Checks that the file did not change since
     * it was loaded ($expectedHash), backs up the previous version first.
     */
    public static function write(string $file, string $xml, ?string $expectedHash = null): array
    {
        $path = self::path($file);
        self::loadDom($xml); // must parse
        if (is_file($path)) {
            $current = file_get_contents($path);
            if ($expectedHash !== null && $expectedHash !== '' && sha1($current) !== $expectedHash) {
                throw new RuntimeException('The template was modified on disk since you opened it. Reload and try again.');
            }
            if ($current === $xml) return ['changed' => false, 'hash' => sha1($xml)];
            self::backup($file, $current);
        }
        $tmp = $path . '.dte-tmp';
        if (file_put_contents($tmp, $xml) === false || !rename($tmp, $path)) {
            @unlink($tmp);
            throw new RuntimeException("Could not write $path");
        }
        return ['changed' => true, 'hash' => sha1($xml)];
    }

    public static function backup(string $file, string $content): string
    {
        $dir = self::backupDir() . '/' . basename($file, '.xml');
        if (!is_dir($dir)) mkdir($dir, 0777, true);
        $dest = $dir . '/' . date('Ymd-His') . '.xml';
        $n = 1;
        while (file_exists($dest)) $dest = $dir . '/' . date('Ymd-His') . '-' . $n++ . '.xml';
        file_put_contents($dest, $content);
        $all = glob($dir . '/*.xml') ?: [];
        sort($all);
        $keep = max(1, (int)self::setting('BACKUP_RETENTION', '25'));
        while (count($all) > $keep) @unlink(array_shift($all));
        return basename($dest);
    }

    public static function backups(string $file): array
    {
        self::path($file);
        $dir = self::backupDir() . '/' . basename($file, '.xml');
        $out = [];
        foreach (array_reverse(glob($dir . '/*.xml') ?: []) as $p) {
            $out[] = ['id' => basename($p), 'mtime' => filemtime($p), 'size' => filesize($p)];
        }
        return $out;
    }

    public static function readBackup(string $file, string $id): string
    {
        self::path($file);
        if (!preg_match('/^[0-9-]+\.xml$/', $id)) throw new InvalidArgumentException('Invalid backup id');
        $p = self::backupDir() . '/' . basename($file, '.xml') . '/' . $id;
        if (!is_file($p)) throw new RuntimeException('Backup not found');
        return file_get_contents($p);
    }

    /* ------------------------------------------------------------------ bulk */

    /**
     * Compute (and optionally apply) a bulk operation across templates.
     *
     * $op = ['kind' => 'replace', 'find' => .., 'replace' => .., 'regex' => bool, 'scope' => 'values'|'all', 'types' => [...]]
     *     | ['kind' => 'setvar', 'key' => .., 'value' => .., 'add' => bool, 'type' => 'Variable']
     *     | ['kind' => 'delvar', 'key' => .., 'type' => 'Variable']
     */
    public static function bulk(array $files, array $op, bool $apply): array
    {
        $results = [];
        foreach ($files as $file) {
            $t = self::load($file);
            if ($t['legacy']) { $results[] = ['file' => $t['file'], 'skipped' => 'legacy template format']; continue; }
            $fields = $t['fields'];
            $configs = $t['configs'];
            $changes = [];
            switch ($op['kind'] ?? '') {
                case 'replace':
                    self::bulkReplace($fields, $configs, $op, $changes);
                    break;
                case 'setvar':
                    self::bulkSetVar($configs, $op, $changes);
                    break;
                case 'delvar':
                    $type = $op['type'] ?? 'Variable';
                    $key = (string)($op['key'] ?? '');
                    $configs = array_values(array_filter($configs, function ($c) use ($type, $key, &$changes) {
                        if (($c['attrs']['Type'] ?? '') === $type && ($c['attrs']['Target'] ?? '') === $key) {
                            $changes[] = ['where' => "$type $key", 'old' => $c['value'], 'new' => '(removed)'];
                            return false;
                        }
                        return true;
                    }));
                    break;
                default:
                    throw new InvalidArgumentException('Unknown bulk operation');
            }
            $row = ['file' => $t['file'], 'name' => $fields['Name'] ?? $t['file'], 'changes' => $changes];
            if ($apply && $changes) {
                $xml = self::build($t['xml'], $fields, $configs);
                $row['written'] = self::write($t['file'], $xml, $t['hash'])['changed'];
            }
            $results[] = $row;
        }
        return $results;
    }

    private static function bulkReplace(array &$fields, array &$configs, array $op, array &$changes): void
    {
        $find = (string)($op['find'] ?? '');
        if ($find === '') throw new InvalidArgumentException('Search text is empty');
        $replace = (string)($op['replace'] ?? '');
        $regex = !empty($op['regex']);
        if ($regex && @preg_match('~' . str_replace('~', '\~', $find) . '~', '') === false) {
            throw new InvalidArgumentException('Invalid regular expression');
        }
        $types = $op['types'] ?? [];
        $scope = $op['scope'] ?? 'values';
        $do = function (string $s) use ($find, $replace, $regex): string {
            return $regex ? preg_replace('~' . str_replace('~', '\~', $find) . '~', $replace, $s) : str_replace($find, $replace, $s);
        };
        foreach ($configs as &$c) {
            $type = $c['attrs']['Type'] ?? '';
            if ($types && !in_array($type, $types, true)) continue;
            $label = $type . ' ' . ($c['attrs']['Target'] ?? '');
            $new = $do($c['value']);
            if ($new !== $c['value']) {
                $changes[] = ['where' => $label, 'old' => $c['value'], 'new' => $new];
                $c['value'] = $new;
            }
            if ($scope === 'all') {
                foreach (['Default', 'Target'] as $a) {
                    if (!isset($c['attrs'][$a])) continue;
                    $nv = $do($c['attrs'][$a]);
                    if ($nv !== $c['attrs'][$a]) {
                        $changes[] = ['where' => "$label ($a)", 'old' => $c['attrs'][$a], 'new' => $nv];
                        $c['attrs'][$a] = $nv;
                    }
                }
            }
        }
        unset($c);
        if ($scope === 'all') {
            foreach (['ExtraParams', 'PostArgs', 'WebUI'] as $f) {
                if (!isset($fields[$f])) continue;
                $nv = $do($fields[$f]);
                if ($nv !== $fields[$f]) {
                    $changes[] = ['where' => $f, 'old' => $fields[$f], 'new' => $nv];
                    $fields[$f] = $nv;
                }
            }
        }
    }

    private static function bulkSetVar(array &$configs, array $op, array &$changes): void
    {
        $key = trim((string)($op['key'] ?? ''));
        if ($key === '') throw new InvalidArgumentException('Key is empty');
        $value = (string)($op['value'] ?? '');
        $type = $op['type'] ?? 'Variable';
        $found = false;
        foreach ($configs as &$c) {
            if (($c['attrs']['Type'] ?? '') === $type && ($c['attrs']['Target'] ?? '') === $key) {
                $found = true;
                if ($c['value'] !== $value) {
                    $changes[] = ['where' => "$type $key", 'old' => $c['value'], 'new' => $value];
                    $c['value'] = $value;
                }
            }
        }
        unset($c);
        if (!$found && !empty($op['add'])) {
            $configs[] = ['attrs' => self::newConfigAttrs($type, $key), 'value' => $value];
            $changes[] = ['where' => "$type $key", 'old' => '(missing)', 'new' => $value];
        }
    }

    public static function newConfigAttrs(string $type, string $key): array
    {
        return [
            'Name' => $key, 'Target' => $key, 'Default' => '',
            'Mode' => $type === 'Port' ? 'tcp' : ($type === 'Path' ? 'rw' : ''),
            'Description' => '', 'Type' => $type, 'Display' => 'always', 'Required' => 'false', 'Mask' => 'false',
        ];
    }
}
