/**
 * The runtime-image verification program, kept here rather than inline in
 * `verify-runtime-image.mjs` so it can be executed against a synthetic
 * node_modules tree without Docker.
 *
 * `buildRuntimeCheck` returns a CommonJS program string that is passed to
 * `node -e` inside the image. The forbidden-package walk is spliced in from
 * this module's own source (see `findForbiddenPackages`) so the test and the
 * real image check run identical logic instead of two copies that can drift.
 */

/**
 * Collect forbidden package directories under an installed node_modules root.
 *
 * `fs` and `path` are parameters rather than a `require` so the same function
 * source runs here (ESM) and inside the container (CommonJS). Keep it free of
 * module-scope references: the spliced copy has no surrounding scope.
 */
export function findForbiddenPackages(modulesRoot, forbiddenNames, fs, path) {
  const forbidden = [];
  // Match the path relative to the node_modules root, not the last segment: a
  // scoped package such as @nestjs/cli presents as `cli` and can never be
  // matched by its full name otherwise. An unscoped name is identical either
  // way, so those entries keep matching unchanged.
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(modulesRoot, full).split(path.sep).join('/');
      if (forbiddenNames.has(rel)) forbidden.push(full);
      if (rel !== '.cache') walk(full);
    }
  };
  walk(modulesRoot);
  return forbidden;
}

export const FORBIDDEN_RUNTIME_PACKAGES = [
  'typescript',
  'ts-node',
  'jest',
  '@nestjs/cli',
  '@nestjs/schematics',
  '@nestjs/testing',
];

/**
 * Build the program run inside the image.
 *
 * argv: [appName, root] — `root` defaults to /app so the deploy step keeps its
 * one-argument call, while the test can point the same program at a fixture.
 */
export function buildRuntimeCheck() {
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const app = process.argv[1];',
    "const root = process.argv[2] || '/app';",
    "const modulesRoot = path.join(root, 'node_modules');",
    'const required = [',
    '  path.join(root, "apps", app, "dist/main.js"),',
    "  path.join(modulesRoot, '@wispace/bot-common/dist/index.js'),",
    '];',
    `const findForbiddenPackages = ${findForbiddenPackages.toString()};`,
    `const forbiddenNames = new Set(${JSON.stringify(FORBIDDEN_RUNTIME_PACKAGES)});`,
    'for (const file of required) {',
    "  if (!fs.existsSync(file)) throw new Error('Missing runtime artifact: ' + file);",
    '}',
    'const forbidden = findForbiddenPackages(modulesRoot, forbiddenNames, fs, path);',
    "if (forbidden.length) throw new Error('Dev-only packages in runtime image: ' + forbidden.join(', '));",
    // Existence checks alone passed a broken image: npm nests a dependency
    // when the hoisted slot holds an incompatible version, and the runtime
    // image used to drop those nested trees, so @wispace/wispace-client shipped
    // without undici. Actually loading each package catches that class.
    "const scopeDir = path.join(modulesRoot, '@wispace');",
    'const unloadable = [];',
    'for (const name of fs.readdirSync(scopeDir)) {',
    "  const entry = path.join(scopeDir, name, 'dist/index.js');",
    '  if (!fs.existsSync(entry)) continue;',
    '  try {',
    '    require(entry);',
    '  } catch (err) {',
    "    unloadable.push(name + ': ' + String(err.message).split(String.fromCharCode(10))[0]);",
    '  }',
    '}',
    "if (unloadable.length) throw new Error('Unloadable workspace packages in runtime image: ' + unloadable.join(' | '));",
    "console.log('runtime artifacts present, workspace packages loadable, dev-only toolchain absent');",
  ].join('\n');
}
