/**
 * AD-28 — the required Node version is declared once and asserted at startup.
 *
 * The floor lives in exactly two places on disk: `.nvmrc` (for version managers) and the
 * `package.json` `engines.node` field (for npm and for this module). Nothing here hardcodes a
 * version number; the floor is read from the manifest, so the two declarations cannot drift from
 * a third copy in code.
 *
 * A stale version-manager `PATH` handing a subprocess a Node below the floor fails as an opaque
 * TypeScript syntax error, which is the failure AD-28 exists to convert into a named one.
 *
 * The Stack's npm bound is asserted the same way and from the same manifest. It is an exclusive upper
 * bound rather than a floor — npm 12 disables git-dependency resolution and install scripts by
 * default, which breaks AD-12's `npx github:<owner>/<repo>` delivery path — and its failure is worth
 * naming for the same reason: unasserted, it shows up as a delivery path that quietly stops working.
 */
import { readFileSync } from 'node:fs';

/**
 * Both `src/contracts/` and the emitted `dist/contracts/` sit exactly two levels below the
 * package root, so one relative URL resolves the manifest from source and from build output.
 */
const PACKAGE_ROOT = new URL('../../', import.meta.url);

/** The two declared homes of the Node floor, named in the failure message. */
export const NODE_FLOOR_DECLARATION_SITES = ['.nvmrc', 'package.json "engines.node"'] as const;

/**
 * The one declared home of the npm bound, named in the failure message.
 *
 * Singular, unlike the Node floor: npm reads `engines.npm` itself and no version manager needs a
 * second file for it, so a literal anywhere in `src/` would be a second authority for one fact.
 */
export const NPM_CEILING_DECLARATION_SITE = 'package.json "engines.npm"' as const;

export interface SemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface NodeFloor extends SemanticVersion {
  /** The raw range as written in `engines.node`, e.g. `>=22.22`. */
  readonly range: string;
  /** The floor as a full three-part version, e.g. `22.22.0`. */
  readonly version: string;
}

/**
 * The npm bound: an *exclusive* upper bound, which is the opposite shape to the Node floor.
 *
 * AD-12's delivery path is `npx github:<owner>/<repo>`, and npm 12 disables git-dependency resolution
 * and install scripts by default. So the declared bound is `<12` and the assertion is that the running
 * npm is below it — not above, as it is for Node.
 */
export interface NpmCeiling extends SemanticVersion {
  /** The raw range as written in `engines.npm`, e.g. `<12`. */
  readonly range: string;
  /** The first version this build refuses, as a full three-part version, e.g. `12.0.0`. */
  readonly version: string;
}

/** Thrown when the running Node is below the declared floor. */
export class NodeFloorError extends Error {
  readonly floor: NodeFloor;
  readonly running: string;

  constructor(message: string, floor: NodeFloor, running: string) {
    super(message);
    this.name = 'NodeFloorError';
    this.floor = floor;
    this.running = running;
  }
}

/**
 * Thrown when the running npm is at or above the declared bound.
 *
 * A separate class from {@link NodeFloorError} because the two failures need different advice: one
 * says upgrade Node, the other says use an older npm, and a caller that caught one shape for both
 * could only print whichever sentence it guessed at.
 */
export class NpmCeilingError extends Error {
  readonly ceiling: NpmCeiling;
  readonly running: string;

  constructor(message: string, ceiling: NpmCeiling, running: string) {
    super(message);
    this.name = 'NpmCeilingError';
    this.ceiling = ceiling;
    this.running = running;
  }
}

const VERSION_PATTERN = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/;
const FLOOR_RANGE_PATTERN = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;
const CEILING_RANGE_PATTERN = /^<\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/**
 * Read a file at the package root, naming the file and the path tried on failure. A bare ENOENT or
 * SyntaxError here is precisely the opaque startup failure AD-28 exists to convert into a named one.
 */
const readPackageFile = (relativePath: string): string => {
  const url = new URL(relativePath, PACKAGE_ROOT);
  try {
    return readFileSync(url, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read ${relativePath} at ${url.pathname} to determine the required Node version (AD-28): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

interface PackageManifest {
  version: string;
  engines: { node: string; npm: string };
}

const readManifest = (): PackageManifest => {
  const raw = readPackageFile('package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Could not parse package.json at ${new URL('package.json', PACKAGE_ROOT).pathname} to determine ` +
        `the required Node version (AD-28): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('package.json did not parse to an object.');
  }
  const record = parsed as Record<string, unknown>;
  const engines = record['engines'];
  const version = record['version'];
  if (typeof engines !== 'object' || engines === null) {
    throw new Error('package.json is missing the "engines" field required by AD-28.');
  }
  const node = (engines as Record<string, unknown>)['node'];
  if (typeof node !== 'string' || typeof version !== 'string') {
    throw new Error('package.json is missing "version" or "engines.node" required by AD-28.');
  }
  const npm = (engines as Record<string, unknown>)['npm'];
  if (typeof npm !== 'string') {
    throw new Error(
      'package.json is missing "engines.npm". The Stack pins npm below 12 because npm 12 disables ' +
        'git-dependency resolution and install scripts by default, which breaks the AD-12 delivery path.',
    );
  }
  return { version, engines: { node, npm } };
};

const manifest = readManifest();

/** This package's own version. AD-12 / AD-28 report it as the installer version. */
export const PACKAGE_VERSION: string = manifest.version;

/** The raw `engines.node` range, e.g. `>=22.22`. */
export const NODE_ENGINES_RANGE: string = manifest.engines.node;

/** The raw `engines.npm` range, e.g. `<12`. Read here so nothing in `src/` repeats the bound. */
export const NPM_ENGINES_RANGE: string = manifest.engines.npm;

/** Parse a `>=X[.Y[.Z]]` range into the floor it declares. */
export const parseNodeFloor = (range: string): NodeFloor => {
  const match = FLOOR_RANGE_PATTERN.exec(range.trim());
  if (match === null) {
    throw new Error(
      `engines.node must declare a simple lower bound of the form ">=X.Y[.Z]" so the Node floor is unambiguous; received "${range}".`,
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2] ?? '0');
  const patch = Number(match[3] ?? '0');
  return { range: range.trim(), major, minor, patch, version: `${major}.${minor}.${patch}` };
};

/** Parse a `<X[.Y[.Z]]` range into the exclusive upper bound it declares. */
export const parseNpmCeiling = (range: string): NpmCeiling => {
  const match = CEILING_RANGE_PATTERN.exec(range.trim());
  if (match === null) {
    throw new Error(
      `engines.npm must declare a simple exclusive upper bound of the form "<X[.Y[.Z]]" so the npm bound is unambiguous; received "${range}".`,
    );
  }
  const major = Number(match[1]);
  const minor = Number(match[2] ?? '0');
  const patch = Number(match[3] ?? '0');
  return { range: range.trim(), major, minor, patch, version: `${major}.${minor}.${patch}` };
};

/**
 * Parse a concrete version such as `22.14.0`, `v24.21.0`, `22.22` or `22`. A missing minor or patch
 * is zero-filled, because all three are legal `.nvmrc` contents.
 */
export const parseVersion = (version: string): SemanticVersion => {
  const match = VERSION_PATTERN.exec(version.trim());
  if (match === null) {
    throw new Error(`Could not read a semantic version from "${version}".`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? '0'),
    patch: Number(match[3] ?? '0'),
  };
};

/** Negative when `a` precedes `b`, zero when equal, positive when `a` follows `b`. */
export const compareVersions = (a: SemanticVersion, b: SemanticVersion): number =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/** The floor declared by this package's `engines.node`. */
export const nodeFloor = (): NodeFloor => parseNodeFloor(NODE_ENGINES_RANGE);

/** The version declared in `.nvmrc`; the second and only other home of the floor. */
export const nvmrcVersion = (): SemanticVersion => {
  const declared = readPackageFile('.nvmrc').trim();
  try {
    return parseVersion(declared);
  } catch {
    throw new Error(
      `.nvmrc declares "${declared}", which is not a version this build can compare against the ` +
        `engines.node floor. AD-28 requires a plain version such as 22.22.0, not an alias.`,
    );
  }
};

export const satisfiesNodeFloor = (version: string, floor: NodeFloor = nodeFloor()): boolean =>
  compareVersions(parseVersion(version), floor) >= 0;

export const nodeFloorMessage = (running: string, floor: NodeFloor = nodeFloor()): string =>
  `Node ${floor.version} or newer is required (declared as "${floor.range}" in ${NODE_FLOOR_DECLARATION_SITES.join(' and ')}); this process is running Node ${running}. ` +
  `Switch to Node ${floor.version} or newer — a version manager whose PATH is stale is the usual cause — and retry.`;

/**
 * Throw unless the given Node version meets the declared floor. Pure and testable; callers that
 * are process entry points use {@link assertNodeFloorOrExit}.
 */
export const assertNodeFloor = (
  running: string = process.versions.node,
  floor: NodeFloor = nodeFloor(),
): void => {
  if (!satisfiesNodeFloor(running, floor)) {
    throw new NodeFloorError(nodeFloorMessage(running, floor), floor, running);
  }
};

/** The bound declared by this package's `engines.npm`. */
export const npmCeiling = (): NpmCeiling => parseNpmCeiling(NPM_ENGINES_RANGE);

export const satisfiesNpmCeiling = (version: string, ceiling: NpmCeiling = npmCeiling()): boolean =>
  compareVersions(parseVersion(version), ceiling) < 0;

export const npmCeilingMessage = (running: string, ceiling: NpmCeiling = npmCeiling()): string =>
  `npm below ${ceiling.version} is required (declared as "${ceiling.range}" in ${NPM_CEILING_DECLARATION_SITE}); this process is running npm ${running}. ` +
  `npm ${String(ceiling.major)} disables git-dependency resolution and install scripts by default, which breaks the AD-12 delivery path — ` +
  `install with an npm below ${ceiling.version} and retry.`;

/**
 * The npm version running this process, or `null` when nothing said.
 *
 * npm puts its own version in `npm_config_user_agent` for every script it runs, which is the only
 * statement about npm available without spawning it. Read rather than probed on purpose: an engine
 * startup that shelled out to `npm --version` would pay for a subprocess on every start to answer a
 * question that only has consequences during an install.
 *
 * `null` is "nobody said", never "it is fine": a process started directly, not through npm, has no npm
 * to refuse. That is the same conservative shape as the engine lock's unreadable start time — an
 * undecided fact never triggers a refusal.
 *
 * **A version this function cannot read is also "nobody said".** pnpm, yarn Berry and bun all write an
 * `npm/` segment into the same variable and all write `npm/?` into it, because they are not npm and have
 * no npm version to declare. Returning `"?"` made {@link parseVersion} throw a plain `Error` inside
 * {@link assertNodeFloorOrExit}, which re-throws anything that is neither a {@link NodeFloorError} nor an
 * {@link NpmCeilingError} — so importing `src/contracts/index.ts` under any of those three package
 * managers killed the whole system at import with an unhandled error, which is the opposite of the named
 * refusal AD-28 exists to give. An unreadable statement decides nothing, exactly as an absent one does.
 */
export const runningNpmVersion = (
  userAgent: string | undefined = process.env['npm_config_user_agent'],
): string | null => {
  const declared = /(?:^|\s)npm\/(\S+)/.exec(userAgent ?? '')?.[1] ?? null;
  if (declared === null) return null;
  return VERSION_PATTERN.test(declared) ? declared : null;
};

/**
 * Throw unless the given npm version is below the declared bound. A `null` version is undecided and
 * passes: see {@link runningNpmVersion}.
 */
export const assertNpmCeiling = (
  running: string | null = runningNpmVersion(),
  ceiling: NpmCeiling = npmCeiling(),
): void => {
  if (running === null) return;
  if (!satisfiesNpmCeiling(running, ceiling)) {
    throw new NpmCeilingError(npmCeilingMessage(running, ceiling), ceiling, running);
  }
};

/**
 * Startup assertion for a process entry point: names the required versions on stderr and exits
 * non-zero. Diagnostics go to stderr, never stdout, per the Consistency Conventions — at this
 * point in startup no event log exists to write to.
 *
 * Both engine bounds are asserted here, in the order they bite: a Node below the floor fails as an
 * opaque syntax error before anything else can be reported, while npm 12 fails later and more
 * obscurely, at the install step of AD-12's delivery path.
 */
export const assertNodeFloorOrExit = (
  running: string = process.versions.node,
  runningNpm: string | null = runningNpmVersion(),
): void => {
  try {
    assertNodeFloor(running);
    assertNpmCeiling(runningNpm);
  } catch (error) {
    // Only a declared-version failure is reported as one. A malformed manifest or an unreadable
    // `.nvmrc` is a different fault and must not be disguised as "this Node is too old".
    if (!(error instanceof NodeFloorError) && !(error instanceof NpmCeilingError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
};
