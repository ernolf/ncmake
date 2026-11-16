<?php
// SPDX-FileCopyrightText: 2026 [ernolf] Raphael Gradenwitz <raphael.gradenwitz@googlemail.com>
// SPDX-License-Identifier: MIT
//
// php-audit.php - the PHP half of make php-audit.
//
// Parses the PHP files below the directories it is given with nikic/php-parser
// and prints one JSON object that php-audit.mjs turns into an inventory and
// findings:
//   php          the PHP that ran the parser
//   files        per file, relative to the app:
//     error      why the file could not be parsed, and nothing else
//     classes    name, kind, line, abstract, extends, implements, traits,
//                attributes and, per method, line, visibility, static, abstract,
//                attributes and the annotations of its doc comment; attrs has
//                each attribute once more with its line and its arguments
//     refs       per class name the file uses, the first line that does
//     news       [line, class, arguments] of every new <class>
//     funcs      [line, function, arguments] of every call of a named function
//     ocserver   the lines that read OC::$server
//     consts     [line, class, name] of every class constant read by name
//     calls      [line, class, method, name, receiver, inner name, inner
//                receiver, arguments] of every method call: the class and the
//                method it stands in, the type of what it is called on where
//                the file states it, and for a call on the result of another
//                call the name and the receiver of that one
//     returns    in appinfo/ only: what the file returns, the way appinfo/routes.php
//                returns its routes
//     registered [line, routes] of every call of registerRoutes()
// An argument is written where it is a constant: c:<class> for <class>::class,
// k:<class>::<NAME> for a class constant, n:<class> for new <class>, s:<text>,
// p:<text> for a text that goes on with something that is no constant,
// i:<number>, b:true, b:false, b:null; anything else is null.
// The arguments of an attribute, what a file returns and the routes of
// registerRoutes() are written as values: a scalar, an array of values,
// {"$const": "<class>::<NAME>"} for a class constant and {"$unknown": true}
// for what is no constant.
//
// This states what the source says and judges nothing: which of it is worth a
// finding depends on the majors the app declares, and that is the analyser's.
// The parser is not installed with Composer: it has no dependency, so its lib/
// is loaded from PHP_AUDIT_PARSER, a directory outside the app.

declare(strict_types=1);

use PhpParser\ConstExprEvaluator;
use PhpParser\Node;
use PhpParser\Node\Expr;
use PhpParser\Node\Name;
use PhpParser\Node\Stmt;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitor\NameResolver;
use PhpParser\NodeVisitorAbstract;
use PhpParser\ParserFactory;

// The image sets no memory limit of its own, and PHP's default is too small for
// the syntax tree of a large file.
ini_set('memory_limit', '-1');

$parserDir = rtrim((string)getenv('PHP_AUDIT_PARSER'), '/');
if ($parserDir === '' || !is_file($parserDir . '/lib/PhpParser/ParserFactory.php')) {
	fwrite(STDERR, "php-audit.php: PHP_AUDIT_PARSER names no nikic/php-parser\n");
	exit(2);
}
spl_autoload_register(static function (string $class) use ($parserDir): void {
	if (strncmp($class, 'PhpParser\\', 10) === 0) {
		$file = $parserDir . '/lib/' . str_replace('\\', '/', $class) . '.php';
		if (is_file($file)) {
			require $file;
		}
	}
});

const MAX_ARGS = 4;
const MAX_TEXT = 200;
const MAX_DEPTH = 8;
const UNKNOWN = ['$unknown' => true];

final class Facts extends NodeVisitorAbstract
{
	public array $classes = [];
	public array $refs = [];
	public array $news = [];
	public array $funcs = [];
	public array $ocserver = [];
	public array $calls = [];
	public array $consts = [];
	public array $registered = [];
	public array $migrations = [];

	/** @var list<array{name: ?string, parent: ?string, props: array<string, string>, record: ?int}> */
	private array $classStack = [];
	/** @var list<array{method: ?string, vars: array<string, string>}> */
	private array $scopeStack = [];
	private ConstExprEvaluator $evaluator;

	public function __construct()
	{
		$this->evaluator = new ConstExprEvaluator();
	}

	private function currentClass(): ?string
	{
		return $this->classStack ? $this->classStack[count($this->classStack) - 1]['name'] : null;
	}

	private function currentMethod(): ?string
	{
		return $this->scopeStack ? $this->scopeStack[count($this->scopeStack) - 1]['method'] : null;
	}

	private function className(Name $name): ?string
	{
		$lower = $name->toLowerString();
		if ($lower === 'self' || $lower === 'static') {
			return $this->currentClass();
		}
		if ($lower === 'parent') {
			return $this->classStack ? $this->classStack[count($this->classStack) - 1]['parent'] : null;
		}
		return $name->toString();
	}

	/** The class a type declaration names, the first one of a union. */
	private function typeName(?Node $type): ?string
	{
		if ($type instanceof Node\NullableType) {
			return $this->typeName($type->type);
		}
		if ($type instanceof Node\UnionType || $type instanceof Node\IntersectionType) {
			foreach ($type->types as $t) {
				$name = $this->typeName($t);
				if ($name !== null) {
					return $name;
				}
			}
			return null;
		}
		return $type instanceof Name ? $this->className($type) : null;
	}

	/** The class of what an expression yields, where the file states it. */
	private function typeOf(?Node $e): ?string
	{
		if ($e instanceof Expr\Variable && is_string($e->name)) {
			if ($e->name === 'this') {
				return $this->currentClass();
			}
			return $this->scopeStack ? ($this->scopeStack[count($this->scopeStack) - 1]['vars'][$e->name] ?? null) : null;
		}
		if (($e instanceof Expr\PropertyFetch || $e instanceof Expr\NullsafePropertyFetch)
			&& $e->var instanceof Expr\Variable && $e->var->name === 'this' && $e->name instanceof Node\Identifier) {
			return $this->classStack ? ($this->classStack[count($this->classStack) - 1]['props'][$e->name->name] ?? null) : null;
		}
		if ($e instanceof Name) {
			return $this->className($e);
		}
		if ($e instanceof Expr\New_ && $e->class instanceof Name) {
			return $this->className($e->class);
		}
		// <container>->get(X::class) and Server::get(X::class) yield an X.
		if (($e instanceof Expr\MethodCall || $e instanceof Expr\StaticCall) && $e->name instanceof Node\Identifier
			&& in_array($e->name->name, ['get', 'query'], true) && isset($e->args[0]) && $e->args[0] instanceof Node\Arg) {
			$arg = $this->constant($e->args[0]->value);
			return $arg !== null && strncmp($arg, 'c:', 2) === 0 ? substr($arg, 2) : null;
		}
		return null;
	}

	private function constant(Node $e): ?string
	{
		if ($e instanceof Expr\ClassConstFetch && $e->class instanceof Name && $e->name instanceof Node\Identifier) {
			$class = $this->className($e->class);
			if ($class === null) {
				return null;
			}
			return $e->name->name === 'class' ? 'c:' . $class : 'k:' . $class . '::' . $e->name->name;
		}
		if ($e instanceof Expr\New_ && $e->class instanceof Name) {
			$class = $this->className($e->class);
			return $class === null ? null : 'n:' . $class;
		}
		if ($e instanceof Node\Scalar\String_) {
			return 's:' . substr($e->value, 0, MAX_TEXT);
		}
		if ($e instanceof Expr\ConstFetch) {
			$name = $e->name->toLowerString();
			return in_array($name, ['true', 'false', 'null'], true) ? 'b:' . $name : null;
		}
		try {
			$value = $this->evaluator->evaluateSilently($e);
		} catch (\Throwable $ex) {
			// A text that goes on with a variable still says how it starts.
			$lead = $e;
			while ($lead instanceof Expr\BinaryOp\Concat) {
				$lead = $lead->left;
			}
			if ($lead instanceof Node\Scalar\InterpolatedString) {
				$lead = $lead->parts[0] ?? null;
			}
			if ($lead !== $e && ($lead instanceof Node\Scalar\String_ || $lead instanceof Node\InterpolatedStringPart)) {
				return 'p:' . substr($lead->value, 0, MAX_TEXT);
			}
			return null;
		}
		if (is_int($value)) {
			return 'i:' . $value;
		}
		return is_string($value) ? 's:' . substr($value, 0, MAX_TEXT) : null;
	}

	/**
	 * What an expression is worth where it is a constant: a scalar, an array
	 * of values, ['$const' => <class>::<NAME>] for a class constant, whose
	 * value another file has, and UNKNOWN for anything else. One element that
	 * is no constant leaves the rest of its array readable.
	 *
	 * @return mixed
	 */
	public function value(Node $e, int $depth = 0)
	{
		if ($e instanceof Expr\Array_) {
			if ($depth >= MAX_DEPTH) {
				return UNKNOWN;
			}
			$out = [];
			foreach ($e->items as $item) {
				if ($item === null || $item->unpack) {
					$out[] = UNKNOWN;
					continue;
				}
				$value = $this->value($item->value, $depth + 1);
				if ($item->key === null) {
					$out[] = $value;
					continue;
				}
				$key = $this->value($item->key, $depth + 1);
				if (is_string($key) || is_int($key)) {
					$out[$key] = $value;
				} else {
					$out[] = UNKNOWN;
				}
			}
			return $out;
		}
		if ($e instanceof Expr\ClassConstFetch) {
			if (!($e->class instanceof Name) || !($e->name instanceof Node\Identifier)) {
				return UNKNOWN;
			}
			$class = $this->className($e->class);
			if ($class === null) {
				return UNKNOWN;
			}
			return $e->name->name === 'class' ? $class : ['$const' => $class . '::' . $e->name->name];
		}
		if ($e instanceof Expr\ConstFetch) {
			$name = $e->name->toLowerString();
			return $name === 'true' ? true : ($name === 'false' ? false : ($name === 'null' ? null : UNKNOWN));
		}
		try {
			$value = $this->evaluator->evaluateSilently($e);
		} catch (\Throwable $ex) {
			return UNKNOWN;
		}
		return is_scalar($value) || $value === null ? $value : UNKNOWN;
	}

	/**
	 * Every attribute with its line and its arguments: a named argument under
	 * its name, any other under its position.
	 *
	 * @param Node\AttributeGroup[] $groups
	 */
	private function attrs(array $groups): array
	{
		$out = [];
		foreach ($groups as $group) {
			foreach ($group->attrs as $attr) {
				$args = [];
				foreach ($attr->args as $i => $arg) {
					$args[$arg->name !== null ? $arg->name->name : $i] = $this->value($arg->value);
				}
				$out[] = ['name' => $attr->name->toString(), 'line' => $attr->getStartLine(), 'args' => $args === [] ? new stdClass() : $args];
			}
		}
		return $out;
	}

	/** @param array<Node\Arg|Node\VariadicPlaceholder> $args */
	private function arguments(array $args): array
	{
		$out = [];
		foreach (array_slice($args, 0, MAX_ARGS) as $arg) {
			$out[] = $arg instanceof Node\Arg ? $this->constant($arg->value) : null;
		}
		return $out;
	}

	/** @param Node\AttributeGroup[] $groups */
	private static function attributes(array $groups): array
	{
		$names = [];
		foreach ($groups as $group) {
			foreach ($group->attrs as $attr) {
				$names[] = $attr->name->toString();
			}
		}
		return $names;
	}

	private function names(array $names): array
	{
		return array_values(array_filter(array_map(fn (Name $n) => $this->className($n), $names)));
	}

	private function enterClass(Stmt\ClassLike $node): void
	{
		$name = isset($node->namespacedName) ? $node->namespacedName->toString() : null;
		$extends = [];
		if ($node instanceof Stmt\Class_ && $node->extends !== null) {
			$extends = [$node->extends->toString()];
		} elseif ($node instanceof Stmt\Interface_) {
			$extends = array_map(static fn (Name $n) => $n->toString(), $node->extends);
		}
		$frame = ['name' => $name, 'parent' => $node instanceof Stmt\Class_ ? ($extends[0] ?? null) : null, 'props' => [], 'record' => null];
		$this->classStack[] = $frame;
		$top = count($this->classStack) - 1;

		// What the class states about the type of its properties: a declared type,
		// a promoted constructor parameter, or a typed constructor parameter that
		// the constructor assigns to the property.
		$props = [];
		$methods = [];
		$traits = [];
		foreach ($node->stmts as $stmt) {
			if ($stmt instanceof Stmt\Property) {
				$type = $this->typeName($stmt->type);
				if ($type !== null) {
					foreach ($stmt->props as $prop) {
						$props[$prop->name->name] = $type;
					}
				}
			} elseif ($stmt instanceof Stmt\TraitUse) {
				foreach ($stmt->traits as $trait) {
					$traits[] = $trait->toString();
				}
			} elseif ($stmt instanceof Stmt\ClassMethod) {
				$doc = $stmt->getDocComment();
				preg_match_all('/^[\s\/*]*@([A-Z][A-Za-z]+)/m', $doc === null ? '' : $doc->getText(), $m);
				$methods[$stmt->name->name] = [
					'line' => $stmt->getStartLine(),
					'visibility' => $stmt->isPrivate() ? 'private' : ($stmt->isProtected() ? 'protected' : 'public'),
					'static' => $stmt->isStatic(),
					'abstract' => $stmt->isAbstract() || $node instanceof Stmt\Interface_,
					'attributes' => self::attributes($stmt->attrGroups),
					'attrs' => $this->attrs($stmt->attrGroups),
					'annotations' => array_values(array_unique($m[1])),
				];
				if ($stmt->name->toLowerString() !== '__construct') {
					continue;
				}
				$typed = [];
				foreach ($stmt->params as $param) {
					$type = $this->typeName($param->type);
					if ($type === null || !($param->var instanceof Expr\Variable) || !is_string($param->var->name)) {
						continue;
					}
					$typed[$param->var->name] = $type;
					if ($param->flags !== 0) {
						$props[$param->var->name] = $type;
					}
				}
				foreach ($stmt->stmts ?? [] as $s) {
					$e = $s instanceof Stmt\Expression ? $s->expr : null;
					if ($e instanceof Expr\Assign && $e->var instanceof Expr\PropertyFetch
						&& $e->var->var instanceof Expr\Variable && $e->var->var->name === 'this' && $e->var->name instanceof Node\Identifier
						&& $e->expr instanceof Expr\Variable && is_string($e->expr->name) && isset($typed[$e->expr->name])) {
						$props[$e->var->name->name] ??= $typed[$e->expr->name];
					}
				}
			}
		}
		$this->classStack[$top]['props'] = $props;
		if ($name === null) {
			return;
		}
		$this->classes[] = [
			'name' => $name,
			'kind' => $node instanceof Stmt\Interface_ ? 'interface' : ($node instanceof Stmt\Trait_ ? 'trait' : ($node instanceof Stmt\Enum_ ? 'enum' : 'class')),
			'line' => $node->getStartLine(),
			'abstract' => $node instanceof Stmt\Class_ && $node->isAbstract(),
			'extends' => $extends,
			'implements' => $node instanceof Stmt\Class_ || $node instanceof Stmt\Enum_ ? array_map(static fn (Name $n) => $n->toString(), $node->implements) : [],
			'traits' => $traits,
			'attributes' => self::attributes($node->attrGroups),
			'attrs' => $this->attrs($node->attrGroups),
			'methods' => $methods === [] ? new stdClass() : $methods,
		];
	}

	private function enterFunction(Node\FunctionLike $node): void
	{
		$inherits = $node instanceof Expr\Closure || $node instanceof Expr\ArrowFunction;
		$vars = $inherits && $this->scopeStack ? $this->scopeStack[count($this->scopeStack) - 1]['vars'] : [];
		foreach ($node->getParams() as $param) {
			if (!($param->var instanceof Expr\Variable) || !is_string($param->var->name)) {
				continue;
			}
			$type = $this->typeName($param->type);
			if ($type !== null) {
				$vars[$param->var->name] = $type;
			} else {
				unset($vars[$param->var->name]);
			}
		}
		$method = $node instanceof Stmt\ClassMethod ? $node->name->name : ($inherits ? $this->currentMethod() : null);
		$this->scopeStack[] = ['method' => $method, 'vars' => $vars];
	}

	public function enterNode(Node $node)
	{
		if ($node instanceof Stmt\ClassLike) {
			$this->enterClass($node);
			return null;
		}
		if ($node instanceof Node\FunctionLike) {
			$this->enterFunction($node);
			return null;
		}
		$line = $node->getStartLine();
		if ($node instanceof Name\FullyQualified) {
			if (!$node->getAttribute('noClass')) {
				$this->refs[$node->toString()] ??= $line;
			}
		} elseif ($node instanceof Expr\FuncCall) {
			if ($node->name instanceof Name) {
				// The name of a function is no class name.
				$node->name->setAttribute('noClass', true);
				$this->funcs[] = [$line, $node->name->toLowerString(), $this->arguments($node->args)];
			}
		} elseif ($node instanceof Expr\ConstFetch) {
			$node->name->setAttribute('noClass', true);
		} elseif ($node instanceof Expr\New_) {
			if ($node->class instanceof Name) {
				$class = $this->className($node->class);
				if ($class !== null) {
					$this->news[] = [$line, $class, $this->arguments($node->args)];
				}
			}
		} elseif ($node instanceof Expr\ClassConstFetch) {
			if ($node->class instanceof Name && $node->name instanceof Node\Identifier && $node->name->toLowerString() !== 'class') {
				$class = $this->className($node->class);
				if ($class !== null) {
					$this->consts[] = [$line, $class, $node->name->name];
				}
			}
		} elseif ($node instanceof Expr\StaticPropertyFetch) {
			if ($node->class instanceof Name && $node->class->toString() === 'OC'
				&& $node->name instanceof Node\VarLikeIdentifier && $node->name->name === 'server') {
				$this->ocserver[] = $line;
			}
		} elseif ($node instanceof Expr\Assign) {
			if ($node->var instanceof Expr\Variable && is_string($node->var->name) && $this->scopeStack) {
				$type = $this->typeOf($node->expr);
				$top = count($this->scopeStack) - 1;
				if ($type !== null) {
					$this->scopeStack[$top]['vars'][$node->var->name] = $type;
				} else {
					unset($this->scopeStack[$top]['vars'][$node->var->name]);
				}
			}
		} elseif (($node instanceof Expr\MethodCall || $node instanceof Expr\NullsafeMethodCall || $node instanceof Expr\StaticCall)
			&& $node->name instanceof Node\Identifier) {
			$on = $node instanceof Expr\StaticCall ? $node->class : $node->var;
			$innerName = $innerType = null;
			if (($on instanceof Expr\MethodCall || $on instanceof Expr\NullsafeMethodCall || $on instanceof Expr\StaticCall)
				&& $on->name instanceof Node\Identifier) {
				$innerName = $on->name->name;
				$innerType = $this->typeOf($on instanceof Expr\StaticCall ? $on->class : $on->var);
			}
			$this->calls[] = [$line, $this->currentClass(), $this->currentMethod(), $node->name->name,
				$this->typeOf($on), $innerName, $innerType, $this->arguments($node->args)];
			if ($node->name->name === 'registerRoutes' && isset($node->args[1]) && $node->args[1] instanceof Node\Arg) {
				$this->registered[] = [$line, $this->value($node->args[1]->value)];
			}
		}
		return null;
	}

	/** The table an expression of changeSchema stands for: [name, created], or null. */
	private function tableOf(Node $e): ?array
	{
		if ($e instanceof Expr\Variable && is_string($e->name)) {
			return $this->scopeStack[count($this->scopeStack) - 1]['tables'][$e->name] ?? null;
		}
		if ($e instanceof Expr\MethodCall && $e->name instanceof Node\Identifier
			&& in_array($e->name->name, ['createTable', 'getTable'], true) && isset($e->args[0]) && $e->args[0] instanceof Node\Arg) {
			return [$this->value($e->args[0]->value), $e->name->name === 'createTable'];
		}
		return null;
	}

	/** The column an expression of changeSchema stands for: [table, created, column], or null. */
	private function columnOf(Node $e): ?array
	{
		if ($e instanceof Expr\Variable && is_string($e->name)) {
			return $this->scopeStack[count($this->scopeStack) - 1]['columns'][$e->name] ?? null;
		}
		if ($e instanceof Expr\MethodCall && $e->name instanceof Node\Identifier
			&& in_array($e->name->name, ['addColumn', 'getColumn'], true) && isset($e->args[0]) && $e->args[0] instanceof Node\Arg) {
			$table = $this->tableOf($e->var);
			return $table === null ? null : [$table[0], $table[1], $this->value($e->args[0]->value)];
		}
		return null;
	}

	/**
	 * Every call of changeSchema on a table, a column or the schema, as
	 * [line, table, created, method, arguments, column]. It runs as the node
	 * is left, so a call is recorded after the calls its receiver holds.
	 */
	private function migration(Node $node): void
	{
		if (!$this->scopeStack || $this->currentMethod() !== 'changeSchema') {
			return;
		}
		$top = count($this->scopeStack) - 1;
		if ($node instanceof Expr\Assign && $node->var instanceof Expr\Variable && is_string($node->var->name)) {
			$name = $node->var->name;
			unset($this->scopeStack[$top]['tables'][$name], $this->scopeStack[$top]['columns'][$name]);
			$table = $this->tableOf($node->expr);
			$column = $table === null ? $this->columnOf($node->expr) : null;
			if ($table !== null) {
				$this->scopeStack[$top]['tables'][$name] = $table;
			} elseif ($column !== null) {
				$this->scopeStack[$top]['columns'][$name] = $column;
			}
			return;
		}
		if (!($node instanceof Expr\MethodCall) || !($node->name instanceof Node\Identifier)) {
			return;
		}
		$method = $node->name->name;
		$args = [];
		foreach (array_slice($node->args, 0, MAX_ARGS) as $arg) {
			$args[] = $arg instanceof Node\Arg ? $this->value($arg->value) : UNKNOWN;
		}
		$line = $node->getStartLine();
		if (in_array($method, ['createTable', 'dropTable'], true)) {
			$this->migrations[] = [$line, $args[0] ?? UNKNOWN, $method === 'createTable', $method, [], null];
		} elseif (($table = $this->tableOf($node->var)) !== null) {
			$this->migrations[] = [$line, $table[0], $table[1], $method, $args, null];
		} elseif (($column = $this->columnOf($node->var)) !== null) {
			$this->migrations[] = [$line, $column[0], $column[1], $method, $args, $column[2]];
		}
	}

	public function leaveNode(Node $node)
	{
		$this->migration($node);
		if ($node instanceof Stmt\ClassLike) {
			array_pop($this->classStack);
		} elseif ($node instanceof Node\FunctionLike) {
			array_pop($this->scopeStack);
		}
		return null;
	}
}

$files = [];
foreach (array_slice($argv, 1) as $dir) {
	if (!is_dir($dir)) {
		continue;
	}
	$walk = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
	foreach ($walk as $file) {
		if ($file->isFile() && !$file->isLink() && strtolower($file->getExtension()) === 'php') {
			$files[] = str_replace('\\', '/', $file->getPathname());
		}
	}
}
sort($files, SORT_STRING);

$parser = (new ParserFactory())->createForNewestSupportedVersion();
$out = [];
foreach ($files as $path) {
	$code = file_get_contents($path);
	if ($code === false) {
		$out[$path] = ['error' => 'could not be read'];
		continue;
	}
	try {
		// Two passes: a visitor sees a node before the name resolver has seen its
		// children, so the arguments of a call would still carry the names as
		// the file writes them.
		$resolver = new NodeTraverser();
		$resolver->addVisitor(new NameResolver());
		$facts = new Facts();
		$traverser = new NodeTraverser();
		$traverser->addVisitor($facts);
		$ast = $resolver->traverse($parser->parse($code) ?? []);
		$traverser->traverse($ast);
		// What a file of appinfo/ returns: the last return at its top level.
		$returns = null;
		if (strncmp($path, 'appinfo/', 8) === 0) {
			$top = $ast;
			foreach ($ast as $stmt) {
				if ($stmt instanceof Stmt\Namespace_) {
					$top = array_merge($top, $stmt->stmts);
				}
			}
			foreach ($top as $stmt) {
				if ($stmt instanceof Stmt\Return_ && $stmt->expr !== null) {
					$returns = ['line' => $stmt->getStartLine(), 'value' => $facts->value($stmt->expr)];
				}
			}
		}
	} catch (\Throwable $e) {
		$out[$path] = ['error' => $e->getMessage()];
		continue;
	}
	$out[$path] = [
		'classes' => $facts->classes,
		'refs' => $facts->refs === [] ? new stdClass() : $facts->refs,
		'news' => $facts->news,
		'funcs' => $facts->funcs,
		'ocserver' => $facts->ocserver,
		'calls' => $facts->calls,
		'consts' => $facts->consts,
		'registered' => $facts->registered,
		'migrations' => $facts->migrations,
	];
	if ($returns !== null) {
		$out[$path]['returns'] = $returns;
	}
}

$json = json_encode(
	['php' => PHP_VERSION, 'files' => $out === [] ? new stdClass() : $out],
	JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
);
if ($json === false) {
	fwrite(STDERR, 'php-audit.php: ' . json_last_error_msg() . "\n");
	exit(2);
}
echo $json, "\n";
