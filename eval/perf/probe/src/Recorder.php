<?php

namespace OneShotShop\PerfProbe;

use Illuminate\Database\Events\QueryExecuted;

/**
 * Collects per-request work metrics. Everything here is machine-independent except the
 * *_ms fields, which are recorded as secondary information only.
 */
class Recorder
{
    /** Same statement shape executed at least this often in one request = N+1 suspect. */
    public const N_PLUS_ONE_MIN = 5;
    public const MAX_SQL_CHARS = 2000;
    public const MAX_STATEMENTS = 300;

    private string $id;
    private float $t0;
    private bool $flushed = false;
    /** @var array<string, array> keyed by sha1(connection|normalized) */
    private array $stmts = [];
    private int $queries = 0;
    private float $queryMs = 0.0;
    private int $writes = 0;
    private ?array $req = null;
    private ?array $resp = null;
    private array $extra = [];

    public function start(): void
    {
        $this->t0 = defined('LARAVEL_START') ? (float) LARAVEL_START : (float) ($_SERVER['REQUEST_TIME_FLOAT'] ?? microtime(true));
        $this->id = sprintf('%s-%d-%s', base_convert((string) (int) ($this->t0 * 1000), 10, 36), getmypid(), bin2hex(random_bytes(4)));
    }

    public function id(): string
    {
        return $this->id;
    }

    public static function normalize(string $sql): string
    {
        $s = preg_replace('/\s+/', ' ', trim($sql));
        // string literals -> ?
        $s = preg_replace("/'(?:[^']|'')*'/", '?', $s);
        // numeric literals not part of identifiers -> ?
        $s = preg_replace('/(?<![\w"`.])-?\d+(?:\.\d+)?(?![\w"`])/', '?', $s);
        // IN lists of any length -> in (?+)
        $s = preg_replace('/\bin\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/i', 'in (?+)', $s);
        // multi-row VALUES -> one tuple
        $s = preg_replace('/(values\s*(\([^()]*\)))(\s*,\s*\([^()]*\))+/i', '$1 /*+rows*/', $s);
        return $s;
    }

    private static function scalar($v)
    {
        if ($v === null || is_scalar($v)) {
            return is_string($v) && strlen($v) > 500 ? substr($v, 0, 500) : $v;
        }
        if ($v instanceof \DateTimeInterface) {
            return $v->format('Y-m-d H:i:s');
        }
        if ($v instanceof \BackedEnum) {
            return $v->value;
        }
        if (is_object($v) && method_exists($v, '__toString')) {
            return (string) $v;
        }
        return null;
    }

    public function query(QueryExecuted $e): void
    {
        try {
            $this->queries++;
            $this->queryMs += (float) $e->time;
            $norm = self::normalize($e->sql);
            $conn = (string) $e->connectionName;
            $key = sha1($conn.'|'.$norm);
            $bindings = array_map([self::class, 'scalar'], array_values((array) $e->bindings));
            $bkey = sha1($e->sql.'|'.json_encode($bindings));
            if (! isset($this->stmts[$key])) {
                $this->stmts[$key] = ['h' => substr($key, 0, 16), 'conn' => $conn, 'sql' => $norm, 'n' => 0, 'ms' => 0.0, 'b' => []];
                $this->sample($key, $conn, $e, $norm, $bindings);
            }
            $st = &$this->stmts[$key];
            $st['n']++;
            $st['ms'] += (float) $e->time;
            $st['b'][$bkey] = ($st['b'][$bkey] ?? 0) + 1;
            if (preg_match('/^\s*(insert|update|delete|replace)\b/i', $e->sql)) {
                $this->writes++;
            }
        } catch (\Throwable $ignored) {
        }
    }

    /** One representative raw statement + bindings per shape, for EXPLAIN QUERY PLAN later. */
    private function sample(string $key, string $conn, QueryExecuted $e, string $norm, array $bindings): void
    {
        $dir = storage_path('perf/samples');
        $file = $dir.'/'.substr($key, 0, 16).'.json';
        if (is_file($file)) {
            return;
        }
        if (! is_dir($dir)) {
            @mkdir($dir, 0777, true);
        }
        $driver = null;
        try {
            $driver = $e->connection->getDriverName();
        } catch (\Throwable $ignored) {
        }
        @file_put_contents($file, json_encode([
            'h' => substr($key, 0, 16), 'connection' => $conn, 'driver' => $driver,
            'normalized' => $norm, 'sql' => $e->sql, 'bindings' => $bindings,
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE));
    }

    private static function pathOf(?string $url): ?string
    {
        if (! $url) {
            return null;
        }
        $p = parse_url($url, PHP_URL_PATH);
        return $p === null || $p === false ? null : $p;
    }

    public function handled($request, $response): void
    {
        try {
            $response->headers->set('X-OSS-Perf-Id', $this->id);
        } catch (\Throwable $ignored) {
        }
        try {
            $route = $request->route();
            $routeName = $routeUri = $action = null;
            if ($route && is_object($route)) {
                $routeName = $route->getName();
                $routeUri = $route->uri();
                $action = $route->getActionName();
            }
            $body = (string) $request->getContent();
            $this->req = [
                'method' => $request->getMethod(),
                'path' => '/'.ltrim($request->path(), '/'),
                'query' => $request->getQueryString() ? substr($request->getQueryString(), 0, 300) : null,
                'route_name' => $routeName,
                'route_uri' => $routeUri,
                'action' => $action,
                'content_type' => $request->headers->get('Content-Type'),
                'accept' => $request->headers->get('Accept'),
                'bytes' => strlen($body),
                'xhr' => $request->ajax(),
                'x_livewire' => $request->headers->has('X-Livewire'),
                'x_inertia' => $request->headers->has('X-Inertia'),
                'referer_path' => self::pathOf($request->headers->get('Referer')),
                // harness traffic marker in the User-Agent: oss-perf-journey / oss-perf-check
                'ua_marker' => preg_match('/oss-perf-(\w+)/', (string) $request->headers->get('User-Agent'), $um) ? $um[1] : null,
            ];
            if ($this->req['x_livewire'] || str_contains($this->req['path'], 'livewire')) {
                $this->extra['livewire'] = self::livewireRequest($body);
            }

            $ct = (string) $response->headers->get('Content-Type');
            $bytes = null;
            $content = null;
            if ($response instanceof \Symfony\Component\HttpFoundation\BinaryFileResponse) {
                $bytes = @filesize($response->getFile()->getPathname()) ?: null;
            } elseif (! ($response instanceof \Symfony\Component\HttpFoundation\StreamedResponse)) {
                $content = $response->getContent();
                $bytes = is_string($content) ? strlen($content) : null;
            }
            $status = $response->getStatusCode();
            $this->resp = [
                'status' => $status,
                'content_type' => $ct ?: null,
                'bytes' => $bytes,
                'x_inertia' => $response->headers->has('X-Inertia'),
                'location_path' => $status >= 300 && $status < 400 ? self::pathOf($response->headers->get('Location')) : null,
                'streamed' => $content === null && $bytes === null,
            ];
            if (is_string($content)) {
                if (stripos($ct, 'html') !== false) {
                    $this->extra['html'] = self::htmlStats($content);
                } elseif ($this->resp['x_inertia'] && stripos($ct, 'json') !== false) {
                    $j = json_decode($content, true);
                    $this->extra['inertia'] = [
                        'component' => is_array($j) ? ($j['component'] ?? null) : null,
                        'props_bytes' => is_array($j) && isset($j['props']) ? strlen(json_encode($j['props'])) : null,
                        'prop_keys' => is_array($j) && is_array($j['props'] ?? null) ? array_slice(array_keys($j['props']), 0, 40) : null,
                    ];
                } elseif ($this->req['x_livewire'] && stripos($ct, 'json') !== false) {
                    $this->extra['livewire_response'] = self::livewireResponse($content);
                }
            }
        } catch (\Throwable $e) {
            $this->extra['probe_error'] = substr($e->getMessage(), 0, 300);
        }
    }

    private static function livewireRequest(string $body): array
    {
        $out = ['version' => null, 'components' => [], 'calls' => [], 'updates' => 0, 'page_path' => null, 'snapshot_bytes' => 0];
        $j = json_decode($body, true);
        if (! is_array($j)) {
            return $out;
        }
        if (isset($j['components']) && is_array($j['components'])) {           // Livewire 3/4
            $out['version'] = 3;
            foreach ($j['components'] as $c) {
                $snapRaw = is_string($c['snapshot'] ?? null) ? $c['snapshot'] : json_encode($c['snapshot'] ?? null);
                $out['snapshot_bytes'] += strlen((string) $snapRaw);
                $snap = json_decode((string) $snapRaw, true);
                $memo = is_array($snap) ? ($snap['memo'] ?? []) : [];
                $out['components'][] = $memo['name'] ?? null;
                $out['page_path'] = $out['page_path'] ?? ($memo['path'] ?? null);
                $out['updates'] += is_array($c['updates'] ?? null) ? count($c['updates']) : 0;
                foreach ((array) ($c['calls'] ?? []) as $call) {
                    $out['calls'][] = $call['method'] ?? null;
                }
            }
        } elseif (isset($j['fingerprint'])) {                                    // Livewire 2
            $out['version'] = 2;
            $out['components'][] = $j['fingerprint']['name'] ?? null;
            $out['page_path'] = isset($j['fingerprint']['path']) ? '/'.ltrim($j['fingerprint']['path'], '/') : null;
            $out['snapshot_bytes'] = strlen(json_encode($j['serverMemo'] ?? null));
            foreach ((array) ($j['updates'] ?? []) as $u) {
                if (($u['type'] ?? null) === 'callMethod') {
                    $out['calls'][] = $u['payload']['method'] ?? null;
                } else {
                    $out['updates']++;
                }
            }
        }
        return $out;
    }

    private static function livewireResponse(string $content): array
    {
        $j = json_decode($content, true);
        $html = 0;
        $n = 0;
        if (is_array($j) && isset($j['components']) && is_array($j['components'])) {
            foreach ($j['components'] as $c) {
                $n++;
                $html += strlen((string) ($c['effects']['html'] ?? ''));
            }
        }
        return ['components' => $n, 'html_bytes' => $html];
    }

    private static function htmlStats(string $html): array
    {
        $out = [
            'livewire_components' => preg_match_all('/\swire:id="/', $html),
            'livewire_snapshot_bytes' => 0,
            'inertia_page_bytes' => null,
            'inertia_component' => null,
            'scripts' => preg_match_all('/<script\b/i', $html),
        ];
        if (preg_match_all('/\swire:snapshot="([^"]*)"/', $html, $m)) {
            foreach ($m[1] as $s) {
                $out['livewire_snapshot_bytes'] += strlen(html_entity_decode($s));
            }
        }
        $page = null;
        if (preg_match('/\sdata-page="([^"]*)"/', $html, $m)) {
            $page = html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5);
        } elseif (preg_match('/<script[^>]*data-page[^>]*>(.*?)<\/script>/s', $html, $m)) {
            $page = $m[1];
        }
        if ($page !== null) {
            $out['inertia_page_bytes'] = strlen($page);
            $j = json_decode($page, true);
            $out['inertia_component'] = is_array($j) ? ($j['component'] ?? null) : null;
        }
        return $out;
    }

    private static function kind(?array $req, ?array $resp): string
    {
        if (! $req || ! $resp) {
            return 'unknown';
        }
        $ct = strtolower((string) $resp['content_type']);
        if ($req['x_livewire']) {
            return 'livewire';
        }
        if ($req['x_inertia'] || $resp['x_inertia']) {
            return $resp['status'] >= 300 && $resp['status'] < 400 ? 'inertia-redirect' : 'inertia';
        }
        if ($resp['status'] >= 300 && $resp['status'] < 400) {
            return 'redirect';
        }
        if (preg_match('#javascript|text/css|font/|application/font|wasm|sourcemap#', $ct)) {
            return 'asset';   // e.g. livewire.js or a font streamed through a Laravel route
        }
        if (str_contains($ct, 'json')) {
            return 'json';
        }
        if (str_contains($ct, 'html')) {
            return 'html';
        }
        if ($resp['streamed'] || $ct === '' || str_starts_with($ct, 'image/') || str_contains($ct, 'pdf') || str_contains($ct, 'octet')) {
            return 'file';
        }
        return 'other';
    }

    public function flush(): void
    {
        if ($this->flushed) {
            return;
        }
        $this->flushed = true;
        try {
            $stmts = array_values($this->stmts);
            $distinct = count($stmts);
            $exactDup = 0;
            $n1 = [];
            foreach ($stmts as &$s) {
                foreach ($s['b'] as $cnt) {
                    $exactDup += $cnt - 1;
                }
                $s['distinct_bindings'] = count($s['b']);
                unset($s['b']);
                $s['ms'] = round($s['ms'], 2);
                if ($s['n'] >= self::N_PLUS_ONE_MIN && preg_match('/^\s*(select|with)\b/i', $s['sql'])) {
                    $n1[] = ['h' => $s['h'], 'n' => $s['n'], 'distinct_bindings' => $s['distinct_bindings'], 'sql' => substr($s['sql'], 0, 400)];
                }
                $s['sql'] = substr($s['sql'], 0, self::MAX_SQL_CHARS);
            }
            unset($s);
            usort($stmts, fn ($a, $b) => $b['n'] <=> $a['n']);
            $rec = [
                'v' => 1,
                'id' => $this->id,
                'ts' => round($this->t0, 3),
                'kind' => self::kind($this->req, $this->resp),
                'req' => $this->req,
                'resp' => $this->resp,
                'db' => [
                    'queries' => $this->queries,
                    'distinct' => $distinct,
                    'repeated_executions' => $this->queries - $distinct,
                    'exact_duplicates' => $exactDup,
                    'writes' => $this->writes,
                    'n_plus_one' => $n1,
                    'time_ms' => round($this->queryMs, 2),
                    'statements' => array_slice($stmts, 0, self::MAX_STATEMENTS),
                    'statements_truncated' => count($stmts) > self::MAX_STATEMENTS,
                ],
                'memory_peak_bytes' => memory_get_peak_usage(false),
                'duration_ms' => round((microtime(true) - $this->t0) * 1000, 1),
                'extra' => $this->extra ?: new \stdClass(),
            ];
            $dir = storage_path('perf');
            if (! is_dir($dir)) {
                @mkdir($dir, 0777, true);
            }
            @file_put_contents($dir.'/requests.jsonl',
                json_encode($rec, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE)."\n",
                FILE_APPEND | LOCK_EX);
        } catch (\Throwable $ignored) {
        }
    }
}
