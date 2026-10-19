import path from "node:path";
import ts from "typescript";

export const RAW_BODY_MODULES = [
  "src/lib/api/bounded-body.ts",
  "src/lib/ingest/receive.ts",
] as const;
export interface BodyPolicy { path: string; method: string; limit: number; code: string }
export interface BodyAudit { violations: string[]; policies: BodyPolicy[] }
const root = process.cwd();
const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
const production = (file: string) => file.startsWith("src/") && !/\.(test|d)\.[cm]?tsx?$/.test(file) &&
  !/(?:^|\/)(?:testing|test-support|fixtures)\//.test(file) && file !== "src/lib/mcp/test-client.ts";
const rawMembers = new Set(["body", "arrayBuffer", "blob", "bytes", "formData", "json", "text", "clone"]);
type Values = Map<ts.Symbol, number | string>;
// Parsed and bound source files, shared by every audit in one test file.
// Each audit still builds its own program and checker; a file whose text an
// override changes is parsed afresh, so a seed never sees another's source.
const parsedSources = new Map<string, { text: string; source: ts.SourceFile }>();

/** Source overrides let every seeded defect compile independently, without
 * mutating the checkout. The same checker inspects the real tree and seeds. */
export function auditBodyPolicy(overrides: Record<string, string> = {}): BodyAudit {
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const options = { ...parsed.options, incremental: false, noEmit: true };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host), exists = host.fileExists.bind(host), parse = host.getSourceFile.bind(host);
  host.readFile = file => overrides[relative(file)] ?? read(file);
  host.fileExists = file => relative(file) in overrides || exists(file);
  host.getSourceFile = (file, version, onError, fresh) => {
    const text = host.readFile(file);
    if (text === undefined) return parse(file, version, onError, fresh);
    const key = `${file}\0${typeof version === "object" ? `${version.languageVersion}:${version.impliedNodeFormat}` : version}`;
    const known = parsedSources.get(key);
    if (known?.text === text) return known.source;
    const source = parse(file, version, onError, fresh);
    if (source) parsedSources.set(key, { text, source });
    return source;
  };
  const program = ts.createProgram([...new Set([...parsed.fileNames.filter(file => production(relative(file))), ...Object.keys(overrides).map(file => path.join(root, file))])], options, host);
  const checker = program.getTypeChecker();
  const files = program.getSourceFiles().filter(file => production(relative(file.fileName)));
  const violations: string[] = [];
  const report = (node: ts.Node, why: string) => {
    const file = node.getSourceFile(); const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    violations.push(`${relative(file.fileName)}:${line}: ${why}`);
  };
  function symbol(node: ts.Node): ts.Symbol | undefined {
    const value = checker.getSymbolAtLocation(node);
    return value && value.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(value) : value;
  }
  function requestType(type: ts.Type, seen = new Set<ts.Type>()): boolean {
    if (seen.has(type)) return false; seen.add(type);
    if (type.isUnionOrIntersection()) return type.types.some(item => requestType(item, seen));
    if (["Request", "NextRequest"].includes(type.getSymbol()?.getName() ?? "")) return true;
    if (type.aliasTypeArguments?.some(item => requestType(item, seen))) return true;
    return !!(type.flags & ts.TypeFlags.Object) && !!(type as ts.InterfaceType).getBaseTypes?.()?.some(item => requestType(item, seen));
  }
  const isRequest = (node: ts.Node) => requestType(checker.getTypeAtLocation(node));
  const bounded = (node: ts.Node) => checker.typeToString(checker.getTypeAtLocation(node)).includes("BoundedJsonRequest");
  function literal(node: ts.Expression | undefined, values: Values, seen = new Set<ts.Node>()): number | string | undefined {
    if (!node || seen.has(node)) return; seen.add(node);
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return literal(node.expression, values, seen);
    if (ts.isBinaryExpression(node)) {
      const left = literal(node.left, values, new Set(seen)), right = literal(node.right, values, new Set(seen));
      if (typeof left === "number" && typeof right === "number") {
        if (node.operatorToken.kind === ts.SyntaxKind.AsteriskToken) return left * right;
        if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
      }
    }
    const key = symbol(ts.isPropertyAccessExpression(node) ? node.name : node);
    if (key && values.has(key)) return values.get(key);
    const declaration = key?.valueDeclaration;
    if (declaration && (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration))) return literal(declaration.initializer, values, seen);
  }
  function errorCode(options: ts.Expression | undefined): string {
    if (!options || !ts.isObjectLiteralExpression(options)) return "request_body_too_large";
    const prop = options.properties.find(p => p.name?.getText() === "tooLarge");
    const expression = prop && ts.isPropertyAssignment(prop) ? prop.initializer : prop && ts.isShorthandPropertyAssignment(prop) ? prop.name : undefined;
    const declaration = expression && ts.isIdentifier(expression) ? checker.getShorthandAssignmentValueSymbol(prop as ts.ShorthandPropertyAssignment)?.valueDeclaration ?? symbol(expression)?.valueDeclaration : expression;
    let code = "request_body_too_large";
    if (declaration) {
      const inspect = (node: ts.Node) => { if (ts.isNewExpression(node) && node.expression.getText() === "ApiError") code = String(literal(node.arguments?.[0], new Map()) ?? code); ts.forEachChild(node, inspect); };
      inspect(declaration);
    }
    return code;
  }
  // Raw body access is excluded by receiver type, even in an uncalled helper.
  for (const file of files) {
    const allowed = (RAW_BODY_MODULES as readonly string[]).includes(relative(file.fileName));
    const inspect = (node: ts.Node) => {
      if (ts.isAsExpression(node) && bounded(node) && relative(file.fileName) !== "src/lib/api/bounded-handoff.ts") report(node, "bounded Request brand forged outside the handoff");
      if (!allowed && (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
        // The member is named before the receiver is typed: typing every
        // receiver in the tree is most of an audit's cost.
        const member = ts.isPropertyAccessExpression(node) ? node.name.text : literal(node.argumentExpression, new Map());
        if ((member === undefined || rawMembers.has(String(member))) && isRequest(node.expression)) report(node, `raw Request body member ${member ?? "computed"} outside a named reader`);
      }
      if (!allowed && ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isRequest(node.initializer)) {
        for (const item of node.name.elements) if (rawMembers.has((item.propertyName ?? item.name).getText())) report(item, "destructured raw Request body member outside a named reader");
      }
      ts.forEachChild(node, inspect);
    };
    inspect(file);
  }
  const policies: BodyPolicy[] = [];
  for (const file of files.filter(file => /src\/app\/api\/.*\/route\.ts$/.test(relative(file.fileName)))) {
    const apiPath = "/" + relative(file.fileName).slice("src/app/".length, -"/route.ts".length).split("/").filter(part => !/^\(.*\)$/.test(part)).map(part => part.replace(/^\[(?:\.\.\.)?(.+)\]$/, "{$1}")).join("/");
    for (const entry of file.statements) {
      if (!ts.isFunctionDeclaration(entry) || !entry.name || !entry.modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword) || !/^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/.test(entry.name.text)) continue;
      const found = new Map<string, { limit: number; code: string }>();
      const visited = new Set<string>();
      function visitFunction(declaration: ts.SignatureDeclaration | ts.JSDocSignature, values: Values) {
        if (!production(relative(declaration.getSourceFile().fileName))) return;
        const visitKey = declaration.getSourceFile().fileName + ":" + declaration.pos + ":" + [...values.values()].join(",");
        if (visited.has(visitKey)) return; visited.add(visitKey);
        const inspect = (node: ts.Node) => {
          if (ts.isCallExpression(node)) {
            const resolved = checker.getResolvedSignature(node)?.declaration;
            const name = resolved && "name" in resolved ? resolved.name?.getText() : undefined;
            const owner = resolved && relative(resolved.getSourceFile().fileName);
            if (name === "boundedBodyText" && owner === "src/lib/api/bounded-body.ts") {
              const limit = literal(node.arguments[1], values), code = errorCode(node.arguments[2]);
              if (typeof limit !== "number") report(node, "unresolved JSON byte policy");
              else found.set(`${limit}:${code}`, { limit, code });
            } else if (resolved && production(owner!) && node.arguments.some(isRequest)) {
              const next = new Map<ts.Symbol, number | string>();
              resolved.parameters.forEach((parameter, index) => {
                const key = symbol(parameter.name), value = literal(node.arguments[index], values);
                if (key && value !== undefined) next.set(key, value);
              });
              visitFunction(resolved, next);
            } else if (resolved && !production(owner!)) {
              for (const argument of node.arguments) if (isRequest(argument) && !bounded(argument)) report(argument, "unbounded Request passed to an external consumer");
            }
          }
          if (ts.isNewExpression(node) && node.expression.getText() === "Request" && node.arguments?.some(isRequest) && relative(node.getSourceFile().fileName) !== "src/lib/api/bounded-handoff.ts") report(node, "incoming Request cloned outside the bounded handoff");
          ts.forEachChild(node, inspect);
        };
        // Inspect function bodies, not their parameter types or unrelated siblings.
        if ("body" in declaration && declaration.body) inspect(declaration.body as ts.Node);
      }
      visitFunction(entry, new Map());
      for (const policy of found.values()) policies.push({ path: apiPath, method: entry.name.text.toLowerCase(), ...policy });
    }
  }
  return { violations: [...new Set(violations)].sort(), policies };
}

export function bodyPolicyProblems(audit: BodyAudit, document: { paths: unknown }): string[] {
  const problems = [...audit.violations];
  const enforced = new Map(audit.policies.map(policy => [`${policy.method} ${policy.path}`, policy]));
  const documented = new Set<string>();
  type Operation = { description?: string; requestBody?: { "x-byte-limit"?: number; "x-byte-error"?: string; content?: Record<string, unknown> }; responses?: Record<string, unknown> };
  for (const [path, methods] of Object.entries(document.paths as Record<string, Record<string, Operation>>)) for (const [method, operation] of Object.entries(methods)) {
    if (!operation.requestBody?.content?.["application/json"] && operation.requestBody?.["x-byte-limit"] === undefined) continue;
    const key = `${method} ${path}`, limit = operation.requestBody["x-byte-limit"], code = operation.requestBody["x-byte-error"] ?? "request_body_too_large";
    documented.add(key);
    const policy = enforced.get(key);
    if (!policy || limit !== policy.limit || code !== policy.code) problems.push(`${key}: documented byte policy ${limit}/${code} differs from enforced ${policy?.limit}/${policy?.code}`);
    if (!operation.description?.includes(`At most ${limit?.toLocaleString("en-US")} wire bytes`) || !operation.description.includes(`\`${code}\` before JSON parsing`)) problems.push(`${key}: stale byte policy description`);
    if (!operation.responses?.["413"]) problems.push(`${key}: missing 413 response`);
  }
  for (const key of enforced.keys()) if (!documented.has(key)) problems.push(`${key}: enforced byte policy is undocumented`);
  return problems.sort();
}
