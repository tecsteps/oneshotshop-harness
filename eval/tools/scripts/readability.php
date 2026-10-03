<?php
// Line-length readability metrics per language group over the committed app code.
// Reads a NUL-separated file list (git ls-files, same exclusions as cloc) on stdin; run in /src.
// Lengths are in characters (UTF-8), trailing newline/CR excluded; avg/p95 over non-blank lines.
$groups = ['PHP' => [], 'Blade' => [], 'JS/TS/Vue' => [], 'CSS' => []];
$group = function (string $f): ?string {
    if (preg_match('/\.min\.(js|css)$/i', $f)) return null;
    if (preg_match('/\.blade\.php$/i', $f)) return 'Blade';
    if (preg_match('/\.php$/i', $f)) return 'PHP';
    if (preg_match('/\.(js|mjs|cjs|ts|mts|cts|jsx|tsx|vue)$/i', $f)) return 'JS/TS/Vue';
    if (preg_match('/\.(css|scss|sass|less)$/i', $f)) return 'CSS';
    return null;
};
$files = array_filter(explode("\0", stream_get_contents(STDIN)), 'strlen');
$stats = [];
$longest = [];
foreach ($files as $f) {
    $g = $group($f);
    if ($g === null || !is_file($f)) continue;
    $s = &$stats[$g];
    $s ??= ['files' => 0, 'lines' => 0, 'over_120' => 0, 'over_200' => 0, 'max' => 0, 'max_at' => null, 'lens' => []];
    $s['files']++;
    $n = 0;
    foreach (preg_split('/\n/', rtrim((string) file_get_contents($f), "\n")) as $i => $line) {
        $line = rtrim($line, "\r");
        $len = mb_strlen($line, 'UTF-8');
        $n++;
        if ($len > 120) $s['over_120']++;
        if ($len > 200) $s['over_200']++;
        if ($len > $s['max']) { $s['max'] = $len; $s['max_at'] = "$f:" . ($i + 1); }
        if (trim($line) !== '') $s['lens'][] = $len;
        if ($len > 120) $longest[] = ['at' => "$f:" . ($i + 1), 'length' => $len, 'group' => $g];
    }
    $s['lines'] += $n;
    unset($s);
}
$out = ['groups' => []];
$tot = ['files' => 0, 'lines' => 0, 'over_120' => 0, 'over_200' => 0];
foreach (array_keys($groups) as $g) {
    $s = $stats[$g] ?? null;
    if (!$s) { $out['groups'][$g] = null; continue; }
    $lens = $s['lens']; sort($lens);
    $c = count($lens);
    $out['groups'][$g] = [
        'files' => $s['files'], 'lines' => $s['lines'],
        'lines_over_120' => $s['over_120'], 'lines_over_200' => $s['over_200'],
        'over_120_per_1000_lines' => $s['lines'] ? round($s['over_120'] / $s['lines'] * 1000, 2) : 0,
        'over_200_per_1000_lines' => $s['lines'] ? round($s['over_200'] / $s['lines'] * 1000, 2) : 0,
        'max_line_length' => $s['max'], 'max_line_at' => $s['max_at'],
        'avg_line_length' => $c ? round(array_sum($lens) / $c, 1) : 0,
        'p95_line_length' => $c ? $lens[(int) ceil(0.95 * $c) - 1] : 0,
    ];
    foreach ($tot as $k => $_) $tot[$k] += $s[$k] ?? 0;
}
$tot['lines_over_120'] = $tot['over_120']; $tot['lines_over_200'] = $tot['over_200'];
unset($tot['over_120'], $tot['over_200']);
$tot['over_120_per_1000_lines'] = $tot['lines'] ? round($tot['lines_over_120'] / $tot['lines'] * 1000, 2) : 0;
$tot['over_200_per_1000_lines'] = $tot['lines'] ? round($tot['lines_over_200'] / $tot['lines'] * 1000, 2) : 0;
$out['total'] = $tot;
usort($longest, fn ($a, $b) => [$b['length'], $a['at']] <=> [$a['length'], $b['at']]);
$out['longest_lines'] = array_slice($longest, 0, 10);
$out['definition'] = 'characters per physical line (UTF-8); avg/p95 over non-blank lines; thresholds 120 and 200';
echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
