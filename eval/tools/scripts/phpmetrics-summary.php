<?php
// Condenses a PhpMetrics --report-json + --report-violations into the fields of the v1 website
// (code-quality.tsx: overview, complexity, maintainability, coupling, violations, halstead,
// topComplex, leastMaintainable, mostCoupled). Usage: php phpmetrics-summary.php report.json violations.xml version
[$_, $jsonFile, $xmlFile, $version] = $argv + [null, null, null, ''];
$report = json_decode(file_get_contents($jsonFile), true) ?: [];
$classes = array_values(array_filter($report, fn ($m) => ($m['_type'] ?? '') === 'Hal\\Metric\\ClassMetric'));
$n = count($classes);
$col = fn (string $k) => array_map(fn ($c) => (float) ($c[$k] ?? 0), $classes);
$avg = fn (array $v) => count($v) ? round(array_sum($v) / count($v), 2) : 0;
$pct = fn (int $c) => $n ? round($c / $n * 100, 1) : 0;
$dist = function (array $values, array $buckets) use ($pct) {
    $out = [];
    foreach ($buckets as $key => [$label, $fn]) {
        $c = count(array_filter($values, $fn));
        $out[$key] = ['count' => $c, 'pct' => $pct($c), 'label' => $label];
    }
    return $out;
};
$short = function (array $c) {
    $name = $c['name'];
    $pos = strrpos($name, '\\');
    return ['name' => $pos === false ? $name : substr($name, $pos + 1), 'ns' => $pos === false ? '' : substr($name, 0, $pos)];
};
$sortBy = function (string $k, bool $desc, int $limit) use ($classes) {
    $copy = $classes;
    usort($copy, fn ($a, $b) => $desc ? (($b[$k] ?? 0) <=> ($a[$k] ?? 0)) : (($a[$k] ?? 0) <=> ($b[$k] ?? 0)));
    return array_slice($copy, 0, $limit);
};

$loc = $col('loc');
$cloc = $col('cloc');
$ccn = $col('ccn');
$mi = $col('mi');
$lcom = $col('lcom');

// Violations: PMD XML priorities 1 critical, 2 error, 3 warning, 4 information.
$violations = ['total' => 0, 'critical' => 0, 'errors' => 0, 'warnings' => 0, 'info' => 0, 'by_rule' => []];
if ($xmlFile && is_file($xmlFile)) {
    $xml = @simplexml_load_file($xmlFile);
    foreach ($xml ? $xml->xpath('//violation') : [] as $v) {
        $p = (int) $v['priority'];
        $key = [1 => 'critical', 2 => 'errors', 3 => 'warnings'][$p] ?? 'info';
        $violations[$key]++;
        $violations['total']++;
        $rule = (string) $v['rule'];
        $violations['by_rule'][$rule] = ($violations['by_rule'][$rule] ?? 0) + 1;
    }
}

$out = [
    'overview' => [
        'totalClasses' => $n,
        'totalLoc' => (int) array_sum($loc),
        'avgLocPerClass' => $avg($loc),
        'commentRatio' => array_sum($loc) ? round(array_sum($cloc) / array_sum($loc) * 100, 2) : 0,
        'phpMetricsVersion' => $version,
    ],
    'complexity' => [
        'avgCcn' => $avg($ccn),
        'avgWmc' => $avg($col('wmc')),
        'maxMethodComplexity' => (int) max([0, ...$col('ccnMethodMax')]),
        'distribution' => $dist($ccn, [
            'low' => ['Low (CCN <= 5)', fn ($v) => $v <= 5],
            'medium' => ['Medium (6-10)', fn ($v) => $v > 5 && $v <= 10],
            'high' => ['High (> 10)', fn ($v) => $v > 10],
        ]),
    ],
    'maintainability' => [
        'avgMi' => $avg($mi),
        'minMi' => $n ? min($mi) : 0,
        'maxMi' => $n ? max($mi) : 0,
        'distribution' => $dist($mi, [
            'excellent' => ['Excellent (>= 85)', fn ($v) => $v >= 85],
            'good' => ['Good (70-84)', fn ($v) => $v >= 70 && $v < 85],
            'moderate' => ['Moderate (55-69)', fn ($v) => $v >= 55 && $v < 70],
            'low' => ['Low (< 55)', fn ($v) => $v < 55],
        ]),
    ],
    'coupling' => [
        'avgAfferent' => $avg($col('afferentCoupling')),
        'avgEfferent' => $avg($col('efferentCoupling')),
        'avgInstability' => $avg($col('instability')),
        'avgLcom' => $avg($lcom),
        'maxLcom' => (int) max([0, ...$lcom]),
    ],
    'violations' => $violations,
    'halstead' => [
        'avgVolume' => $avg($col('volume')),
        'avgDifficulty' => $avg($col('difficulty')),
        'avgBugsPerClass' => round($n ? array_sum($col('bugs')) / $n : 0, 3),
        'totalEstimatedBugs' => round(array_sum($col('bugs')), 2),
    ],
    'topComplex' => array_map(fn ($c) => $short($c) + ['ccn' => $c['ccn'], 'wmc' => $c['wmc'], 'loc' => $c['loc'], 'mi' => $c['mi'], 'coupling' => $c['efferentCoupling'] ?? 0], $sortBy('ccn', true, 5)),
    'leastMaintainable' => array_map(fn ($c) => $short($c) + ['mi' => $c['mi'], 'ccn' => $c['ccn'], 'loc' => $c['loc']], $sortBy('mi', false, 5)),
    'mostCoupled' => array_map(fn ($c) => ['name' => $short($c)['name'], 'coupling' => $c['afferentCoupling'] ?? 0], $sortBy('afferentCoupling', true, 5)),
];
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
