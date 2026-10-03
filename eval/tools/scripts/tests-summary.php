<?php
// JUnit (PHPUnit/Pest) + Clover -> tests, assertions, passed/failed/errors/skipped, line coverage.
[$_, $junit, $clover] = $argv + [null, null, null];
$out = ['tests' => null, 'assertions' => null, 'passed' => null, 'failed' => null, 'errors' => null, 'skipped' => null,
        'line_coverage_pct' => null, 'covered_statements' => null, 'statements' => null, 'failures' => []];
if ($junit && is_file($junit) && ($x = @simplexml_load_file($junit))) {
    $top = $x->getName() === 'testsuite' ? $x : ($x->testsuite[0] ?? null);
    $sum = ['tests' => 0, 'assertions' => 0, 'failures' => 0, 'errors' => 0, 'skipped' => 0];
    // Sum the top-level suites (each top-level <testsuite> already aggregates its children).
    $suites = $x->getName() === 'testsuite' ? [$x] : iterator_to_array($x->testsuite, false);
    foreach ($suites as $s) foreach ($sum as $k => $_v) $sum[$k] += (int) ($s[$k] ?? 0);
    $out['tests'] = $sum['tests'];
    $out['assertions'] = $sum['assertions'];
    $out['failed'] = $sum['failures'];
    $out['errors'] = $sum['errors'];
    $out['skipped'] = $sum['skipped'];
    $out['passed'] = max(0, $sum['tests'] - $sum['failures'] - $sum['errors'] - $sum['skipped']);
    foreach ($x->xpath('//testcase[failure or error]') as $tc) {
        if (count($out['failures']) >= 25) break;
        $out['failures'][] = trim(($tc['class'] ?? $tc['file'] ?? '') . '::' . $tc['name'], ':');
    }
}
if ($clover && is_file($clover) && ($c = @simplexml_load_file($clover))) {
    $m = $c->project->metrics ?? null;
    if ($m) {
        $st = (int) $m['statements'];
        $cov = (int) $m['coveredstatements'];
        $out['statements'] = $st;
        $out['covered_statements'] = $cov;
        $out['line_coverage_pct'] = $st > 0 ? round($cov / $st * 100, 2) : 0.0;
    }
}
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
