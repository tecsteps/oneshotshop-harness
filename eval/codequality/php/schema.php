<?php
// Database schema dump for eval/codequality. Runs INSIDE the prepared app (after migrate --seed),
// with /workspace as the working directory:   php /cq/php/schema.php > schema.json
// Uses Laravel's own schema introspection (Schema::getTables/getColumns/getIndexes/getForeignKeys),
// so it works for whatever default connection the build configured (SQLite in the gate).
declare(strict_types=1);

require getcwd() . '/vendor/autoload.php';
$app = require getcwd() . '/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

$conn = DB::connection();
$out = ['schema' => 'oneshotshop-cq-db-schema/1', 'driver' => $conn->getDriverName(), 'tables' => []];
$tables = Schema::getTables();
usort($tables, fn ($a, $b) => strcmp($a['name'], $b['name']));
foreach ($tables as $t) {
    $name = $t['name'];
    if (str_starts_with($name, 'sqlite_')) continue;
    $cols = array_map(fn ($c) => [
        'name' => $c['name'], 'type' => $c['type'], 'type_name' => $c['type_name'], 'nullable' => (bool) $c['nullable'],
        'default' => $c['default'], 'auto_increment' => (bool) ($c['auto_increment'] ?? false),
    ], Schema::getColumns($name));
    $idx = array_map(fn ($i) => ['name' => $i['name'], 'columns' => array_values($i['columns']), 'unique' => (bool) $i['unique'], 'primary' => (bool) $i['primary']], Schema::getIndexes($name));
    usort($idx, fn ($a, $b) => strcmp($a['name'], $b['name']));
    $fks = array_map(fn ($f) => ['columns' => array_values($f['columns']), 'foreign_table' => $f['foreign_table'], 'foreign_columns' => array_values($f['foreign_columns']),
        'on_delete' => $f['on_delete'] ?? null, 'on_update' => $f['on_update'] ?? null], Schema::getForeignKeys($name));
    usort($fks, fn ($a, $b) => strcmp(implode(',', $a['columns']), implode(',', $b['columns'])));
    $rows = null;
    try { $rows = (int) DB::table($name)->count(); } catch (\Throwable) {}
    $out['tables'][] = ['name' => $name, 'columns' => $cols, 'indexes' => $idx, 'foreign_keys' => $fks, 'rows' => $rows];
}
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), "\n";
