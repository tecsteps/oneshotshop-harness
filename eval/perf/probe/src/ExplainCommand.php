<?php

namespace OneShotShop\PerfProbe;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

/**
 * php artisan oss-perf:explain [--out=storage/perf/explain.json]
 *
 * Runs EXPLAIN QUERY PLAN (SQLite) for one representative sample (raw SQL + bindings) of every
 * distinct statement shape the probe has seen, and reports full table scans, full index scans,
 * temp B-trees and, for full scans, equality/range columns that no index on that table covers.
 * Never executes the statements themselves.
 */
class ExplainCommand extends Command
{
    protected $signature = 'oss-perf:explain {--out= : output file (default storage/perf/explain.json)}';
    protected $description = 'OneShotShop harness: EXPLAIN QUERY PLAN for every statement shape recorded by the perf probe';

    private array $tableRows = [];
    private array $tableIndexes = [];

    public function handle(): int
    {
        $dir = storage_path('perf/samples');
        $out = $this->option('out') ?: storage_path('perf/explain.json');
        $results = [];
        $skipped = ['non_sqlite' => 0, 'not_explainable' => 0, 'error' => 0];
        foreach (glob($dir.'/*.json') ?: [] as $f) {
            $s = json_decode((string) file_get_contents($f), true);
            if (! is_array($s)) {
                continue;
            }
            if (($s['driver'] ?? 'sqlite') !== 'sqlite') {
                $skipped['non_sqlite']++;
                continue;
            }
            if (! preg_match('/^\s*(select|with|update|delete)\b/i', $s['sql'])) {
                $skipped['not_explainable']++;
                continue;
            }
            $r = ['h' => $s['h'], 'connection' => $s['connection'], 'sql' => substr($s['normalized'], 0, 2000)];
            try {
                $conn = DB::connection($s['connection'] ?: null);
                $rows = $conn->select('EXPLAIN QUERY PLAN '.$s['sql'], $s['bindings'] ?? []);
                $plan = array_map(fn ($row) => (string) ((array) $row)['detail'], $rows);
                $r['plan'] = $plan;
                $r += $this->analyse($conn, $s['sql'], $plan);
            } catch (\Throwable $e) {
                $skipped['error']++;
                $r['error'] = substr($e->getMessage(), 0, 300);
            }
            $results[] = $r;
        }
        $doc = [
            'generated_at' => date('c'),
            'sqlite_version' => $this->sqliteVersion(),
            'statements' => $results,
            'tables' => $this->tableRows,
            'skipped' => $skipped,
        ];
        @mkdir(dirname($out), 0777, true);
        file_put_contents($out, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE));
        $this->line(json_encode(['statements' => count($results), 'skipped' => $skipped, 'out' => $out]));
        return 0;
    }

    private function sqliteVersion(): ?string
    {
        try {
            return (string) ((array) DB::selectOne('select sqlite_version() as v'))['v'];
        } catch (\Throwable $e) {
            return null;
        }
    }

    private function rows($conn, string $table): ?int
    {
        $k = $conn->getName().'|'.$table;
        if (! array_key_exists($k, $this->tableRows)) {
            try {
                $this->tableRows[$k] = (int) ((array) $conn->selectOne('select count(*) as c from "'.str_replace('"', '""', $table).'"'))['c'];
            } catch (\Throwable $e) {
                $this->tableRows[$k] = null;
            }
        }
        return $this->tableRows[$k];
    }

    /** @return string[] leading columns of every index on the table */
    private function indexedLeadingColumns($conn, string $table): array
    {
        $k = $conn->getName().'|'.$table;
        if (! isset($this->tableIndexes[$k])) {
            $cols = [];
            try {
                foreach ($conn->select('PRAGMA index_list("'.str_replace('"', '""', $table).'")') as $ix) {
                    $ix = (array) $ix;
                    $info = $conn->select('PRAGMA index_info("'.str_replace('"', '""', $ix['name']).'")');
                    if ($info) {
                        $first = (array) $info[0];
                        foreach ($info as $i) {
                            $i = (array) $i;
                            if ((int) $i['seqno'] === 0) {
                                $first = $i;
                            }
                        }
                        $cols[] = strtolower((string) $first['name']);
                    }
                }
                // rowid alias (INTEGER PRIMARY KEY) is always indexed
                foreach ($conn->select('PRAGMA table_info("'.str_replace('"', '""', $table).'")') as $c) {
                    $c = (array) $c;
                    if ((int) $c['pk'] === 1 && strtoupper((string) $c['type']) === 'INTEGER') {
                        $cols[] = strtolower((string) $c['name']);
                    }
                }
            } catch (\Throwable $e) {
            }
            $this->tableIndexes[$k] = array_values(array_unique($cols));
        }
        return $this->tableIndexes[$k];
    }

    /** Resolve "SCAN p" (alias) back to the table name using the SQL text. */
    private function resolveTable($conn, string $name, string $sql): string
    {
        if ($this->rows($conn, $name) !== null) {
            return $name;
        }
        unset($this->tableRows[$conn->getName().'|'.$name]);
        $q = '["`]?';
        if (preg_match('/'.$q.'([\w]+)'.$q.'\s+(?:as\s+)?'.$q.preg_quote($name, '/').$q.'(?![\w])/i', $sql, $m)) {
            return $m[1];
        }
        return $name;
    }

    private function analyse($conn, string $sql, array $plan): array
    {
        $full = [];
        $indexScans = [];
        $temp = [];
        foreach ($plan as $d) {
            if (preg_match('/^SCAN (?:TABLE )?("?[\w]+"?)(?: AS (\w+))?(.*)$/', $d, $m)) {
                $name = trim($m[1], '"');
                if (str_starts_with($name, 'CONSTANT') || str_starts_with($name, 'SUBQUERY')) {
                    continue;
                }
                $table = $this->resolveTable($conn, $name, $sql);
                $rest = $m[3];
                $entry = ['table' => $table, 'rows' => $this->rows($conn, $table)];
                if (stripos($rest, 'USING') !== false && stripos($rest, 'INDEX') !== false) {
                    $entry['index'] = trim($rest);
                    $indexScans[] = $entry;
                } else {
                    [$entry['unindexed_filter_columns'], $entry['like_columns']] = $this->unindexedFilterColumns($conn, $table, $name, $sql);
                    $full[] = $entry;
                }
            } elseif (str_contains($d, 'USE TEMP B-TREE')) {
                $temp[] = $d;
            }
        }
        return ['full_scans' => $full, 'index_scans' => $indexScans, 'temp_btree' => $temp];
    }

    /**
     * [columns of this table compared with = / <> / < / > / IN / IS that no index leads with,
     *  columns of this table filtered with LIKE (an index rarely helps there; reported separately)]
     */
    private function unindexedFilterColumns($conn, string $table, string $alias, string $sql): array
    {
        $where = preg_split('/\bwhere\b/i', $sql, 2)[1] ?? '';
        $join = '';
        if (preg_match_all('/\bon\b(.*?)(?=\bjoin\b|\bwhere\b|$)/is', $sql, $mm)) {
            $join = implode(' ', $mm[1]);
        }
        $text = $where.' '.$join;
        $cols = [];
        $likes = [];
        $q = '["`]?';
        $re = '/(?:'.$q.'(\w+)'.$q.'\.)?'.$q.'(\w+)'.$q.'\s*(=|<>|!=|>=|<=|>|<|\bnot\s+in\b|\bin\b|\bnot\s+like\b|\blike\b|\bis\b)/i';
        if (preg_match_all($re, $text, $m, PREG_SET_ORDER)) {
            foreach ($m as $hit) {
                $qual = strtolower($hit[1] ?? '');
                if ($qual !== '' && $qual !== strtolower($table) && $qual !== strtolower($alias)) {
                    continue;
                }
                $col = strtolower($hit[2]);
                if (in_array($col, ['and', 'or', 'not', 'null', 'select', 'exists'], true)) {
                    continue;
                }
                if (stripos($hit[3], 'like') !== false) {
                    $likes[$col] = true;
                } else {
                    $cols[$col] = true;
                }
            }
        }
        $indexed = $this->indexedLeadingColumns($conn, $table);
        $known = [];
        try {
            foreach ($conn->select('PRAGMA table_info("'.str_replace('"', '""', $table).'")') as $c) {
                $known[] = strtolower((string) ((array) $c)['name']);
            }
        } catch (\Throwable $e) {
        }
        return [
            array_values(array_filter(array_keys($cols), fn ($c) => in_array($c, $known, true) && ! in_array($c, $indexed, true))),
            array_values(array_filter(array_keys($likes), fn ($c) => in_array($c, $known, true))),
        ];
    }
}
