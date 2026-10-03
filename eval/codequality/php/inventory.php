<?php
// Deterministic unit inventory + static facts for eval/codequality (no AI).
// Usage: php inventory.php <repo-root> <vendor-autoload.php>  > inventory.json
// The file list is `git ls-files` of <repo-root> (committed files only). Output is sorted and
// contains no timestamps, so the same commit always yields byte-identical JSON.
declare(strict_types=1);

use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\Node\Stmt;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\NameResolver;
use PhpParser\NodeVisitor\ParentConnectingVisitor;
use PhpParser\NodeFinder;
use PhpParser\ParserFactory;

[$self, $root, $autoload] = $argv + [null, null, null];
if (!$root || !$autoload) { fwrite(STDERR, "usage: php inventory.php <repo-root> <autoload.php>\n"); exit(2); }
require $autoload;
$root = rtrim(realpath($root), '/');

$files = [];
exec('git -C ' . escapeshellarg($root) . ' ls-files -z', $out, $code);
if ($code !== 0) { fwrite(STDERR, "git ls-files failed\n"); exit(1); }
foreach (explode("\0", implode("\n", $out)) as $f) { if ($f !== '' && is_file("$root/$f")) $files[] = $f; }
sort($files, SORT_STRING);

$parser = (new ParserFactory())->createForHostVersion();
$finder = new NodeFinder();

const MAGIC_OK = [-1, 0, 1, 2, 10, 100, 1000];
const RAW_STATIC = ['raw', 'select', 'selectOne', 'statement', 'unprepared', 'insert', 'update', 'delete', 'affectingStatement', 'scalar'];
const RAW_METHODS = ['selectRaw', 'whereRaw', 'orWhereRaw', 'havingRaw', 'orHavingRaw', 'orderByRaw', 'groupByRaw', 'fromRaw', 'whereColumnRaw'];
const MASS_METHODS = ['create', 'update', 'fill', 'forceFill', 'forceCreate', 'insert', 'firstOrCreate', 'updateOrCreate', 'firstOrNew', 'make', 'upsert'];
const ROUTE_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'any', 'match'];

$res = ['schema' => 'oneshotshop-cq-inventory/1', 'php_parser' => \Composer\InstalledVersions::getPrettyVersion('nikic/php-parser'),
        'classes' => [], 'files' => [], 'views' => [], 'tests' => [], 'routes' => [], 'migrations' => [], 'errors' => []];

function lines_nonblank(string $src): int { return count(array_filter(explode("\n", $src), fn ($l) => trim($l) !== '')); }
function nm(?Node $n): ?string { if ($n instanceof Node\Name) return $n->toString(); if ($n instanceof Node\Identifier) return $n->toString(); return null; }
function short(string $fq): string { $p = strrpos($fq, '\\'); return $p === false ? $fq : substr($fq, $p + 1); }

function is_stmt_counted(Node $n): bool {
  return $n instanceof Stmt && !($n instanceof Stmt\Namespace_ || $n instanceof Stmt\Use_ || $n instanceof Stmt\GroupUse
    || $n instanceof Stmt\ClassLike || $n instanceof Stmt\ClassMethod || $n instanceof Stmt\Property || $n instanceof Stmt\ClassConst
    || $n instanceof Stmt\Declare_ || $n instanceof Stmt\InlineHTML || $n instanceof Stmt\Nop || $n instanceof Stmt\Block
    || $n instanceof Stmt\TraitUse || $n instanceof Stmt\EnumCase || $n instanceof Stmt\Else_ || $n instanceof Stmt\ElseIf_
    || $n instanceof Stmt\Catch_ || $n instanceof Stmt\Finally_ || $n instanceof Stmt\Case_);
}

function count_statements(array $nodes): int {
  global $finder;
  return count($finder->find($nodes, fn (Node $n) => is_stmt_counted($n)));
}

function ccn(array $nodes): int {
  global $finder;
  $c = 1;
  foreach ($finder->find($nodes, fn (Node $n) => true) as $n) {
    if ($n instanceof Stmt\If_ || $n instanceof Stmt\ElseIf_ || $n instanceof Stmt\For_ || $n instanceof Stmt\Foreach_
      || $n instanceof Stmt\While_ || $n instanceof Stmt\Do_ || $n instanceof Stmt\Catch_ || $n instanceof Expr\Ternary
      || $n instanceof Expr\BinaryOp\Coalesce || $n instanceof Expr\BinaryOp\BooleanAnd || $n instanceof Expr\BinaryOp\BooleanOr
      || $n instanceof Expr\BinaryOp\LogicalAnd || $n instanceof Expr\BinaryOp\LogicalOr) $c++;
    elseif ($n instanceof Stmt\Case_ && $n->cond !== null) $c++;
    elseif ($n instanceof Node\MatchArm && $n->conds !== null) $c += count($n->conds);
  }
  return $c;
}

function nesting(array $nodes, int $depth = 0): int {
  $max = $depth;
  foreach ($nodes as $n) {
    if (!$n instanceof Node) continue;
    $nest = $n instanceof Stmt\If_ || $n instanceof Stmt\For_ || $n instanceof Stmt\Foreach_ || $n instanceof Stmt\While_
      || $n instanceof Stmt\Do_ || $n instanceof Stmt\Switch_ || $n instanceof Stmt\TryCatch || $n instanceof Expr\Closure
      || $n instanceof Expr\ArrowFunction || $n instanceof Expr\Match_;
    foreach ($n->getSubNodeNames() as $sub) {
      $v = $n->$sub;
      $children = is_array($v) ? $v : [$v];
      $max = max($max, nesting(array_filter($children, fn ($c) => $c instanceof Node), $depth + ($nest ? 1 : 0)));
    }
  }
  return $max;
}

function has_dynamic(Node $arg): bool {
  global $finder;
  if ($arg instanceof Node\Scalar\InterpolatedString) return true;
  if ($arg instanceof Expr\BinaryOp\Concat) {
    return (bool) $finder->findFirst([$arg], fn (Node $n) => $n instanceof Expr\Variable || $n instanceof Expr\PropertyFetch
      || $n instanceof Expr\MethodCall || $n instanceof Expr\FuncCall || $n instanceof Expr\StaticCall || $n instanceof Expr\ArrayDimFetch
      || $n instanceof Expr\StaticPropertyFetch || $n instanceof Expr\NullsafePropertyFetch || $n instanceof Expr\NullsafeMethodCall);
  }
  if ($arg instanceof Expr\Variable || $arg instanceof Expr\PropertyFetch || $arg instanceof Expr\ArrayDimFetch) return false; // passing a prepared variable is not interpolation
  return false;
}

function is_request_dump(?Node $e): bool {
  // $request->all() / ->input() / ->post() / request()->all() / Request::all() without arguments
  if ($e instanceof Expr\MethodCall && in_array(nm($e->name), ['all', 'input', 'post', 'except'], true) && (count($e->args) === 0 || nm($e->name) === 'except')) {
    $v = $e->var;
    if ($v instanceof Expr\Variable && is_string($v->name) && in_array(strtolower($v->name), ['request', 'req', 'r'], true)) return true;
    if ($v instanceof Expr\FuncCall && nm($v->name) === 'request') return true;
  }
  if ($e instanceof Expr\StaticCall && short((string) nm($e->class)) === 'Request' && nm($e->name) === 'all') return true;
  if ($e instanceof Expr\FuncCall && nm($e->name) === 'request' && count($e->args) === 0) return false;
  return false;
}

function root_is_route(Node $n): bool {
  while ($n instanceof Expr\MethodCall) $n = $n->var;
  return $n instanceof Expr\StaticCall && in_array(short((string) nm($n->class)), ['Route'], true);
}

function classify(string $file, ?string $fq, ?string $extends, array $implements, Stmt\ClassLike $c): string {
  if (str_starts_with($file, 'tests/')) return 'test_class';
  if (str_starts_with($file, 'database/migrations/')) return 'migration_class';
  if (str_starts_with($file, 'database/seeders/')) return 'seeder';
  if (str_starts_with($file, 'database/factories/')) return 'factory';
  if ($c instanceof Stmt\Enum_) return 'enum';
  if ($c instanceof Stmt\Interface_ || $c instanceof Stmt\Trait_) return 'other';
  if (!str_starts_with($file, 'app/')) return 'other';
  $ns = $fq ?? '';
  $ext = $extends ?? '';
  $impl = implode(' ', $implements);
  $has = fn (string $needle) => str_contains($ns, $needle);
  if (str_starts_with($ext, 'Livewire\\') || str_starts_with($ext, 'Filament\\') || $has('\\Livewire\\') || $has('\\Filament\\')) return 'livewire';
  if ($has('\\Http\\Controllers\\') || str_ends_with($ext, 'Controller')) return 'controller';
  if (str_ends_with($ext, 'FormRequest') || $has('\\Http\\Requests\\')) return 'form_request';
  if ($has('\\Http\\Middleware\\')) return 'middleware';
  if (str_ends_with($ext, 'ServiceProvider') || $has('\\Providers\\')) return 'provider';
  if (in_array(short($ext), ['Model', 'Authenticatable', 'Pivot', 'MorphPivot', 'User'], true) || $has('\\Models\\')) return 'model';
  if (str_ends_with((string) $fq, 'Policy') || $has('\\Policies\\')) return 'policy';
  if (in_array(short($ext), ['Mailable', 'Notification'], true) || $has('\\Mail\\') || $has('\\Notifications\\')) return 'mail_notification';
  if (short($ext) === 'Command' || $has('\\Console\\')) return 'command';
  if ($has('\\Jobs\\') || $has('\\Listeners\\') || $has('\\Events\\') || str_contains($impl, 'ShouldQueue')) return 'job';
  if ($has('\\View\\Components\\')) return 'other';
  return 'service';
}

foreach ($files as $file) {
  $abs = "$root/$file";
  if (str_ends_with($file, '.blade.php')) {
    if (!str_starts_with($file, 'resources/views/')) continue;
    $src = file_get_contents($abs);
    $lines = explode("\n", $src);
    $v = ['file' => $file, 'lines' => count($lines), 'nonblank_lines' => lines_nonblank($src), 'bytes' => strlen($src),
          'max_line_chars' => max(array_map('strlen', $lines) ?: [0]), 'unescaped' => [], 'post_forms' => 0, 'post_forms_csrf' => 0,
          'post_forms_missing_csrf' => [], 'query_like' => []];
    foreach ($lines as $i => $l) {
      if (preg_match_all('/\{!!/', $l, $m)) for ($k = 0; $k < count($m[0]); $k++) $v['unescaped'][] = $i + 1;
      if (preg_match('/(\b[A-Z][A-Za-z]+::(where|find|findOrFail|all|query|first|with|count|latest)\s*\(|\bDB::|->(get|first|count|sum|pluck)\(\s*\))/', $l)) $v['query_like'][] = $i + 1;
    }
    if (preg_match_all('/<form\b[^>]*>/i', $src, $fm, PREG_OFFSET_CAPTURE)) {
      foreach ($fm[0] as [$tag, $off]) {
        if (!preg_match('/method\s*=\s*["\']?\s*post/i', $tag)) continue;
        $v['post_forms']++;
        $end = stripos($src, '</form>', $off);
        $body = substr($src, $off, ($end === false ? strlen($src) : $end) - $off);
        if (preg_match('/@csrf|csrf_field\s*\(|csrf_token\s*\(|name=["\']_token["\']/', $body)) $v['post_forms_csrf']++;
        else $v['post_forms_missing_csrf'][] = substr_count(substr($src, 0, $off), "\n") + 1;
      }
    }
    $res['views'][] = $v;
    continue;
  }
  if (!str_ends_with($file, '.php')) continue;
  if (!preg_match('#^(app|routes|database|tests|config|bootstrap)/#', $file)) continue;
  $src = file_get_contents($abs);
  try { $ast = $parser->parse($src); } catch (\Throwable $e) { $res['errors'][] = ['file' => $file, 'message' => $e->getMessage()]; continue; }
  $tr = new NodeTraverser(); $tr->addVisitor(new NameResolver(null, ['replaceNodes' => true])); $tr->addVisitor(new ParentConnectingVisitor());
  $ast = $tr->traverse($ast);

  // ---- per-file facts
  $stmts = $finder->find($ast, fn (Node $n) => is_stmt_counted($n));
  $byLine = [];
  foreach ($stmts as $s) $byLine[$s->getStartLine()] = ($byLine[$s->getStartLine()] ?? 0) + 1;
  $alone = 0; foreach ($stmts as $s) if ($byLine[$s->getStartLine()] === 1) $alone++;
  $f = ['file' => $file, 'nonblank_lines' => lines_nonblank($src), 'lines' => substr_count($src, "\n") + 1,
        'statements' => count($stmts), 'statements_own_line' => $alone,
        'empty_catch' => [], 'error_suppress' => [], 'magic_numbers' => [], 'env_calls' => [], 'service_location' => [],
        'raw_sql_dynamic' => [], 'mass_assign_request' => [], 'unguard_calls' => []];
  foreach ($finder->find($ast, fn (Node $n) => $n instanceof Stmt\Catch_ && count($n->stmts) === 0) as $n) $f['empty_catch'][] = $n->getStartLine();
  foreach ($finder->findInstanceOf($ast, Expr\ErrorSuppress::class) as $n) $f['error_suppress'][] = $n->getStartLine();
  foreach ($finder->findInstanceOf($ast, Expr\FuncCall::class) as $n) {
    $fn = strtolower((string) nm($n->name));
    if ($fn === 'env' && !str_starts_with($file, 'config/')) $f['env_calls'][] = $n->getStartLine();
    if (in_array($fn, ['app', 'resolve'], true) && !str_starts_with($file, 'app/Providers/') && !str_starts_with($file, 'bootstrap/')
        && (str_starts_with($file, 'app/') || str_starts_with($file, 'routes/'))) {
      // app() without args is container access only when chained (app()->make); app('x') / resolve('x') always
      $parent = $n->getAttribute('parent');
      if (count($n->args) > 0 || ($parent instanceof Expr\MethodCall && in_array(nm($parent->name), ['make', 'makeWith', 'get', 'call'], true)))
        $f['service_location'][] = $n->getStartLine();
    }
  }
  foreach ($finder->findInstanceOf($ast, Expr\StaticCall::class) as $n) {
    $cls = short((string) nm($n->class)); $m = (string) nm($n->name);
    if ($cls === 'App' && in_array($m, ['make', 'makeWith'], true) && str_starts_with($file, 'app/') && !str_starts_with($file, 'app/Providers/')) $f['service_location'][] = $n->getStartLine();
    if ($cls === 'DB' && in_array($m, RAW_STATIC, true) && isset($n->args[0]) && $n->args[0] instanceof Node\Arg && has_dynamic($n->args[0]->value)) $f['raw_sql_dynamic'][] = ['line' => $n->getStartLine(), 'call' => "DB::$m"];
    if ($m === 'unguard') $f['unguard_calls'][] = $n->getStartLine();
    if (in_array($m, MASS_METHODS, true) && isset($n->args[0]) && $n->args[0] instanceof Node\Arg && is_request_dump($n->args[0]->value)) $f['mass_assign_request'][] = $n->getStartLine();
  }
  foreach ($finder->find($ast, fn (Node $n) => $n instanceof Expr\MethodCall || $n instanceof Expr\NullsafeMethodCall) as $n) {
    $m = (string) nm($n->name);
    if (in_array($m, RAW_METHODS, true) && isset($n->args[0]) && $n->args[0] instanceof Node\Arg && has_dynamic($n->args[0]->value)) $f['raw_sql_dynamic'][] = ['line' => $n->getStartLine(), 'call' => "->$m"];
    if (in_array($m, MASS_METHODS, true) && isset($n->args[0]) && $n->args[0] instanceof Node\Arg && is_request_dump($n->args[0]->value)) $f['mass_assign_request'][] = $n->getStartLine();
  }
  if (str_starts_with($file, 'app/')) {
    foreach ($finder->find($ast, fn (Node $n) => $n instanceof Node\Scalar\Int_ || $n instanceof Node\Scalar\Float_) as $n) {
      $val = $n->value; $p = $n->getAttribute('parent');
      if ($p instanceof Expr\UnaryMinus) { $val = -$val; $p = $p->getAttribute('parent'); }
      if (in_array($val, MAGIC_OK, false)) continue;
      // inside a function body only; not as array key; not in const/property/param defaults
      $inFn = false; $q = $n; $isKey = false;
      while ($q = $q->getAttribute('parent')) {
        if ($q instanceof Node\ArrayItem && $q->key !== null && $q->key === ($prev ?? null)) $isKey = true;
        if ($q instanceof Stmt\ClassConst || $q instanceof Stmt\Property || $q instanceof Node\Param || $q instanceof Stmt\Const_) { $inFn = false; break; }
        if ($q instanceof Stmt\ClassMethod || $q instanceof Stmt\Function_ || $q instanceof Expr\Closure || $q instanceof Expr\ArrowFunction) { $inFn = true; break; }
        $prev = $q;
      }
      unset($prev);
      $parentNode = $n->getAttribute('parent');
      if ($parentNode instanceof Node\ArrayItem && $parentNode->key === $n) $isKey = true;
      if ($inFn && !$isKey) $f['magic_numbers'][] = $n->getStartLine();
    }
  }
  $res['files'][] = $f;

  // ---- tests (file level)
  if (str_starts_with($file, 'tests/')) {
    $tests = 0;
    foreach ($finder->findInstanceOf($ast, Stmt\ClassMethod::class) as $m) {
      $isTest = str_starts_with($m->name->toString(), 'test');
      foreach ($m->attrGroups as $g) foreach ($g->attrs as $a) if (short($a->name->toString()) === 'Test') $isTest = true;
      $doc = $m->getDocComment(); if ($doc && str_contains($doc->getText(), '@test')) $isTest = true;
      if ($isTest) $tests++;
    }
    foreach ($finder->findInstanceOf($ast, Expr\FuncCall::class) as $c) if (in_array(nm($c->name), ['test', 'it'], true) && $c->getAttribute('parent') instanceof Stmt\Expression) $tests++;
    $assertions = count($finder->find($ast, fn (Node $n) => ($n instanceof Expr\MethodCall || $n instanceof Expr\StaticCall) && str_starts_with((string) nm($n->name), 'assert')))
      + count($finder->find($ast, fn (Node $n) => $n instanceof Expr\FuncCall && nm($n->name) === 'expect'));
    if (preg_match('#^tests/.+\.php$#', $file) && !in_array(basename($file), ['TestCase.php', 'Pest.php', 'CreatesApplication.php'], true))
      $res['tests'][] = ['file' => $file, 'tests' => $tests, 'assertions' => $assertions, 'nonblank_lines' => $f['nonblank_lines']];
  }

  // ---- routes
  if (str_starts_with($file, 'routes/')) {
    $regs = 0; $closures = 0; $fat = [];
    foreach ($finder->find($ast, fn (Node $n) => ($n instanceof Expr\StaticCall || $n instanceof Expr\MethodCall) && in_array(strtolower((string) nm($n->name)), ROUTE_VERBS, true)) as $c) {
      if (!root_is_route($c)) continue;
      $regs++;
      $action = end($c->args); $action = $action instanceof Node\Arg ? $action->value : null;
      if ($action instanceof Expr\Closure || $action instanceof Expr\ArrowFunction) {
        $closures++;
        $body = $action instanceof Expr\Closure ? $action->stmts : [new Stmt\Return_($action->expr)];
        $simple = count($body) === 1 && $body[0] instanceof Stmt\Return_ && $body[0]->expr instanceof Node
          && (($body[0]->expr instanceof Expr\FuncCall && in_array(nm($body[0]->expr->name), ['view', 'redirect', 'to_route'], true))
              || ($body[0]->expr instanceof Expr\MethodCall && $body[0]->expr->var instanceof Expr\FuncCall && in_array(nm($body[0]->expr->var->name), ['view', 'redirect'], true))
              || ($body[0]->expr instanceof Expr\StaticCall && in_array(short((string) nm($body[0]->expr->class)), ['Inertia', 'Redirect'], true)));
        if (!$simple) $fat[] = $c->getStartLine();
      }
    }
    foreach ($finder->find($ast, fn (Node $n) => $n instanceof Expr\StaticCall && short((string) nm($n->class)) === 'Route' && in_array((string) nm($n->name), ['view', 'redirect', 'permanentRedirect', 'resource', 'apiResource', 'resources'], true)) as $c) $regs++;
    $res['routes'][] = ['file' => $file, 'registrations' => $regs, 'closures' => $closures, 'fat_closures' => $fat, 'nonblank_lines' => $f['nonblank_lines'], 'console' => basename($file) === 'console.php'];
  }

  if (str_starts_with($file, 'database/migrations/')) $res['migrations'][] = ['file' => $file, 'lines' => $f['lines'], 'nonblank_lines' => $f['nonblank_lines']];

  // ---- classes
  foreach ($finder->findInstanceOf($ast, Stmt\ClassLike::class) as $c) {
    if ($c->name === null) continue; // anonymous (e.g. migrations' `return new class`)
    $fq = $c->namespacedName ? $c->namespacedName->toString() : $c->name->toString();
    $extends = $c instanceof Stmt\Class_ && $c->extends ? $c->extends->toString() : null;
    $impl = $c instanceof Stmt\Class_ ? array_map(fn ($i) => $i->toString(), $c->implements) : [];
    $kind = classify($file, $fq, $extends, $impl, $c);
    $methods = []; $privates = []; $deps = [];
    foreach ($c->getMethods() as $m) {
      $body = $m->stmts ?? [];
      $methods[] = ['name' => $m->name->toString(), 'visibility' => $m->isPrivate() ? 'private' : ($m->isProtected() ? 'protected' : 'public'),
        'static' => $m->isStatic(), 'abstract' => $m->isAbstract(), 'line_start' => $m->getStartLine(), 'line_end' => $m->getEndLine(),
        'lines' => $m->getEndLine() - $m->getStartLine() + 1, 'statements' => count_statements($body), 'ccn' => ccn($body),
        'params' => count($m->params), 'nesting' => nesting($body)];
      if ($m->isPrivate() && !str_starts_with($m->name->toString(), '__')) $privates[] = ['type' => 'method', 'name' => $m->name->toString(), 'line' => $m->getStartLine()];
      if ($m->name->toLowerString() === '__construct') foreach ($m->params as $p) if ($p->flags & Stmt\Class_::MODIFIER_PRIVATE && $p->var instanceof Expr\Variable)
        $privates[] = ['type' => 'property', 'name' => (string) $p->var->name, 'line' => $p->getStartLine()];
    }
    foreach ($c->getProperties() as $p) if ($p->isPrivate()) foreach ($p->props as $pp) $privates[] = ['type' => 'property', 'name' => $pp->name->toString(), 'line' => $p->getStartLine()];
    // references inside the class
    $calledNames = []; $fetched = [];
    foreach ($finder->find([$c], fn (Node $n) => $n instanceof Expr\MethodCall || $n instanceof Expr\StaticCall || $n instanceof Expr\NullsafeMethodCall) as $n) if ($n->name instanceof Node\Identifier) $calledNames[$n->name->toLowerString()] = true;
    foreach ($finder->findInstanceOf([$c], Node\Scalar\String_::class) as $s) $calledNames[strtolower($s->value)] = true;
    foreach ($finder->find([$c], fn (Node $n) => $n instanceof Expr\PropertyFetch || $n instanceof Expr\NullsafePropertyFetch || $n instanceof Expr\StaticPropertyFetch) as $n) if ($n->name instanceof Node\Identifier || $n->name instanceof Node\VarLikeIdentifier) $fetched[$n->name->toString()] = true;
    $unused = [];
    foreach ($privates as $p) {
      $used = $p['type'] === 'method' ? isset($calledNames[strtolower($p['name'])]) : isset($fetched[$p['name']]);
      if (!$used) $unused[] = $p;
    }
    foreach ($finder->find([$c], fn (Node $n) => $n instanceof Node\Name) as $n) {
      $s = $n->toString(); $l = strtolower($s);
      if (in_array($l, ['self', 'static', 'parent', 'true', 'false', 'null'], true)) continue;
      $p = $n->getAttribute('parent');
      if ($p instanceof Expr\FuncCall || $p instanceof Expr\ConstFetch || $p instanceof Stmt\Namespace_) continue;
      $deps[$s] = true;
    }
    $model = null;
    if ($kind === 'model') {
      $model = ['fillable' => null, 'guarded' => null, 'casts' => [], 'table' => null];
      foreach ($c->getProperties() as $p) foreach ($p->props as $pp) {
        $n = $pp->name->toString(); $d = $pp->default;
        if ($n === 'fillable' && $d instanceof Expr\Array_) $model['fillable'] = count($d->items);
        if ($n === 'guarded' && $d instanceof Expr\Array_) $model['guarded'] = count($d->items);
        if (($n === 'casts' || $n === 'dates') && $d instanceof Expr\Array_) foreach ($d->items as $it) {
          if ($n === 'casts' && $it?->key instanceof Node\Scalar\String_) $model['casts'][] = $it->key->value;
          if ($n === 'dates' && $it?->value instanceof Node\Scalar\String_) $model['casts'][] = $it->value->value;
        }
        if ($n === 'table' && $d instanceof Node\Scalar\String_) $model['table'] = $d->value;
      }
      $castsM = $c->getMethod('casts');
      if ($castsM) foreach ($finder->findInstanceOf($castsM->stmts ?? [], Node\ArrayItem::class) as $it) if ($it->key instanceof Node\Scalar\String_) $model['casts'][] = $it->key->value;
      foreach ($c->attrGroups as $g) foreach ($g->attrs as $a) if (short($a->name->toString()) === 'Fillable') $model['fillable'] = max(1, count($a->args));
      foreach ($c->attrGroups as $g) foreach ($g->attrs as $a) if (short($a->name->toString()) === 'Table' && isset($a->args[0]) && $a->args[0]->value instanceof Node\Scalar\String_) $model['table'] = $a->args[0]->value->value;
      $model['casts'] = array_values(array_unique($model['casts'])); sort($model['casts']);
    }
    ksort($deps);
    $res['classes'][] = ['id' => "class:$fq", 'fqcn' => $fq, 'name' => $c->name->toString(), 'file' => $file,
      'type' => rtrim(strtolower(substr(strrchr(get_class($c), '\\'), 1)), '_'), 'kind' => $kind, 'extends' => $extends, 'implements' => $impl,
      'line_start' => $c->getStartLine(), 'line_end' => $c->getEndLine(), 'lines' => $c->getEndLine() - $c->getStartLine() + 1,
      'statements' => count_statements($c->stmts), 'methods' => $methods, 'privates' => count($privates), 'unused_privates' => $unused,
      'dependencies' => count($deps), 'model' => $model];
  }
}
usort($res['classes'], fn ($a, $b) => strcmp($a['id'], $b['id']));
echo json_encode($res, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR), "\n";
