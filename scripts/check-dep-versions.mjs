#!/usr/bin/env node
/**
 * Report a third-party dependency declared at two incompatible majors.
 *
 * `packages/learner-profile` sat on `typeorm: ^0.3.20` while every other
 * database-touching workspace sat on `^1.1.0` (#757). Disjoint ranges mean npm
 * cannot hoist one copy, so it installs a second one nested under that
 * workspace and the process loads two ORMs. The symptom is never a clean
 * error: entity metadata and decorator registries are per-copy, so `instanceof`
 * fails across the boundary, and a TypeORM upgrade stops being a single change
 * because one workspace keeps the old semantics.
 *
 * Scoped to the shared-major rule, not full range-overlap. Two ranges in the
 * same major with `^` or `~` can nest a copy, but only the caret form is
 * decidable here: any two `^X.Y.Z` inside one major always intersect. A `~`, a
 * partial version or an alias can be disjoint within a major, and detecting that
 * needs a real solver, so those packages are reported as unverified rather than
 * counted as safe. For `0.y` the breaking axis is the minor (`^0.3.20` and
 * `^0.4.0` nest exactly like two majors do), so the compat axis is `major` above
 * zero and `0.minor` at it.
 *
 * All 241 shared declarations in this repo are `^major.minor.patch`, so the
 * unverified list is empty today and the rule is exact for the current tree
 * rather than merely untriggered.
 *
 * Deliberately not a lockfile check. "Exactly one installed copy" is false on a
 * healthy tree — `@types/node` and `undici` each resolve to two versions
 * because a third-party package pins the older one — so that rule would fail on
 * transitives this repo does not control. What this repo owns is the range it
 * declares, and two incompatible declarations of one package is the cause.
 *
 * `devDependencies` are included because a drifted dev declaration still nests:
 * root holds `typeorm` there, so a workspace pinning a different major nests a
 * copy the same way a runtime declaration would. `dependencies` alone would
 * have missed the shape of #757 itself.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MANIFEST_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies'];
const SCOPE = '@wispace/';

/**
 * Only a caret on a full `major.minor.patch` is provably safe once two
 * declarations share a compat axis: any two `^X.Y.Z` ranges inside one major
 * always intersect, so npm hoists a single copy. A tilde, a partial version, an
 * alias or a range naming no version can all be disjoint from a sibling
 * declaration inside the same major, and this rule cannot tell which — so those
 * packages are reported as unverified rather than passed in silence.
 */
const CARET_PIN = /^\^\d+\.\d+\.\d+$/;

/**
 * The version axis two ranges must agree on, or null when the range names no
 * version and therefore cannot be compared.
 */
export function compatAxis(range) {
  const text = String(range)
    // A protocol prefix carries no version of its own (`workspace:*`, `file:..`).
    .replace(/^(?:workspace|file|git|https?):\S*\s*/, '')
    // `npm:typeorm@^1.1.1` keeps the aliased name in front of the real range, and
    // root already aliases typescript this way.
    .replace(/^npm:/, '')
    .replace(/^[^@]*@/, '');
  const match = /(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  const major = Number(match[1]);
  return major === 0 ? `0.${match[2] ?? 0}` : `${major}`;
}

/** Every workspace directory the root manifest declares, root included. */
function workspaceDirs(root) {
  const rootManifest = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  );
  const patterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : (rootManifest.workspaces?.packages ?? []);

  const dirs = new Set(['.']);
  for (const pattern of patterns) {
    const [head, star] = pattern.split('/');
    if (!star) {
      dirs.add(head);
      continue;
    }
    let entries = [];
    try {
      entries = readdirSync(join(root, head), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.add(`${head}/${entry.name}`);
    }
  }
  return [...dirs].sort();
}

export function checkDepVersions(root) {
  const declarations = new Map();
  let workspacesChecked = 0;

  for (const dir of workspaceDirs(root)) {
    const manifestPath = join(root, dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.name !== 'string') continue;
    workspacesChecked += 1;

    for (const field of MANIFEST_FIELDS) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (name.startsWith(SCOPE)) continue;
        const axis = compatAxis(range);
        if (!declarations.has(name)) declarations.set(name, []);
        declarations.get(name).push({
          workspace: dir,
          field,
          range,
          axis,
          provablyShared: CARET_PIN.test(String(range)),
        });
      }
    }
  }

  const violations = [];
  const unverified = [];
  let shared = 0;

  for (const [name, sites] of [...declarations].sort()) {
    if (sites.length < 2) continue;
    shared += 1;
    const axes = new Set(sites.map((site) => site.axis));
    if (axes.size > 1) {
      violations.push({ name, sites, axes: [...axes].sort() });
      continue;
    }
    if (!sites.every((site) => site.provablyShared))
      unverified.push({ name, sites });
  }

  return { violations, unverified, shared, workspacesChecked };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { violations, unverified, shared, workspacesChecked } =
    checkDepVersions(process.cwd());
  if (violations.length > 0) {
    console.error(
      `Shared dependency version drift (${violations.length}) - one package declared at incompatible majors:`,
    );
    for (const v of violations) {
      console.error(`  ${v.name}`);
      for (const site of v.sites) {
        console.error(`    ${site.workspace}  ${site.field}  ${site.range}`);
      }
      console.error(`    -> majors ${v.axes.join(' vs ')}`);
    }
    console.error(
      '\nAlign every declaration on one major. Disjoint ranges mean npm nests a second copy of the package and one process loads it twice (#757).',
    );
    process.exitCode = 1;
  } else {
    console.log(
      `ok: no shared dependency version drift (${shared} shared packages across ${workspacesChecked} workspaces)`,
    );
    if (unverified.length > 0) {
      console.log(
        `\n${unverified.length} shared package(s) this rule cannot prove safe - confirm each resolves to one copy:`,
      );
      for (const u of unverified) {
        console.log(
          `  ${u.name}  ${u.sites.map((s) => `${s.workspace} ${s.range}`).join('  |  ')}`,
        );
      }
      console.log(
        '  Only ^major.minor.patch is provably safe; a ~, a partial version or an alias can be disjoint inside one major.',
      );
    }
  }
}
