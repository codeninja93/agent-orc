/**
 * One exclusive create that publishes a whole file, for the two claims that decide who may write.
 *
 * **What is wrong with `open(path, 'wx')` and then writing.** The exclusive create is an atomic
 * test-and-set on the *name* and nothing at all on the *contents*: it publishes a zero-length file, and
 * a reader that arrives in the microseconds before the winner's `write` lands sees a claim that exists
 * and says nothing. Story 1-8 hit this on the question outcome, where the consequence was visible —
 * a losing resolver reported the question as torn. Here the consequence is milder and worth stating
 * honestly: both claims are decided by the *create*, so mutual exclusion was never at risk, and a
 * claim that reads back as nothing degrades to refusing the lock, which is the fail-safe direction.
 * What it cost was the refusal's ability to name the holder, and an empty file that no later process
 * will reclaim — an `ORCH_HOME` that reads as held by nobody, for ever.
 *
 * **The shape, which is story 1-8's.** Write the content to a temporary file in the same directory,
 * `fsync` it, then `link(2)` it to the real name, then `fsync` the directory. `link` is the same atomic
 * test-and-set — the second linker gets `EEXIST`, on every filesystem this runs on — but the inode it
 * publishes already holds the whole record. So a reader sees the claim complete or sees no claim.
 * `rename` would not do: it replaces the target, so it decides nothing.
 *
 * **The directory's `fsync` is the half that was missing.** The file's own `fsync` makes its *contents*
 * survive a power loss; only the directory's makes the *name* survive one. Story 1-8's
 * `writeQuestionState` calls `fsyncDirectory` for exactly that reason and story 1-9's intent writer does
 * the same, and this module's docblock claimed to be "deliberately identical in shape" to them while
 * omitting it — so the `link(2)` that publishes the claim was not durable across a power loss and the
 * claim could come back absent with its temporary already gone. `fsyncDirectory` is exported from this
 * same layer, so the fix is to make the claim true rather than to write a fourth copy of the call.
 *
 * `EEXIST` is the only failure that means "somebody else holds it". `EACCES`, `ENOSPC` and `EROFS` say
 * nothing about a holder, and reporting one of them as a lost race would tell a user that a disk fault
 * was another engine. `EPERM`, `EOPNOTSUPP`, `ENOTSUP` and `ENOSYS` from the `link` are a third thing
 * again — a filesystem with no hard links at all, which some network and container-mounted volumes are —
 * and they get {@link HardLinksUnsupported}, because a raw errno escaping `Recorder.open` tells a person
 * nothing about what to do and there is no correct fallback: `rename` would replace the claim it is
 * supposed to contend for, which is the one thing this module exists not to do.
 *
 * It lives in `src/runtime/` because both call sites need it and the dependency direction only allows
 * one of them to import the other: the recorder's writer claim is here, the AD-30 engine lock is in
 * `src/engine/`, and the engine may depend on the runtime. `src/engine/questions.ts` keeps its own copy
 * of the idiom, which this one is deliberately identical in shape to; unifying them would edit story
 * 1-8's compare-and-set, which is not this story's subject.
 */
import { closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Imported rather than re-implemented, from the module that already owns the call.
 *
 * `fsyncDirectory` is a runtime concern about making a rename or a link durable, and it is exported
 * from `runtime/commands.ts` because the intent writer needed it first. A private copy here would be
 * the fourth, and the whole point of this module is that there are not several copies of one idiom.
 */
import { fsyncDirectory } from './commands.js';

/** Distinguishes this process's temporaries from a concurrent one's, and one call's from the next. */
let tempCounter = 0;

const TEMP_SUFFIX = '.tmp';

/** The errno a failed `fs` call reports, or `null` when it reported none. */
const errnoOf = (thrown: unknown): string | null => {
  const code = (thrown as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};

/**
 * The errnos that mean "this filesystem does not do hard links", as opposed to "somebody else holds it"
 * or "the disk is in trouble". `EPERM` is in the list because that is what Linux reports for a `link`
 * on a filesystem that has no link operation at all.
 */
const NO_HARD_LINKS = new Set(['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS', 'EMLINK']);

/**
 * The claim could not be published because the filesystem underneath it has no hard links.
 *
 * Named rather than left as a raw errno, because the two callers — the recorder's writer claim and the
 * AD-30 engine lock — both surface out of an `open`/`acquire` a person invoked, and `EPERM: operation
 * not permitted, link` names neither the file nor anything to do about it. There is deliberately no
 * fallback: `rename` publishes by replacing, so it would take a claim another process already holds.
 */
export class HardLinksUnsupported extends Error {
  readonly code = 'config.invalid';
  readonly path: string;
  readonly errno: string;

  constructor(path: string, errno: string) {
    super(
      `Could not publish the claim at ${path}: the filesystem reported ${errno} for link(2), which ` +
        'means it does not support hard links. The claim is taken by linking a fully-written temporary ' +
        'into place, because that is the only publish that is atomic *and* whole — so a filesystem with ' +
        'no hard links cannot hold one safely. Put ORCH_HOME on a local filesystem rather than on a ' +
        'network or container-mounted volume that lacks them.',
    );
    this.name = 'HardLinksUnsupported';
    this.path = path;
    this.errno = errno;
  }
}

/**
 * Create `path` holding `contents`, or answer `false` because another process created it first.
 *
 * The directory is **not** created here. Both callers create their own — `Recorder.open` makes the run
 * directory and `EngineLock.acquire` makes `ORCH_HOME` — and a module whose whole subject is "who got
 * there first" quietly bringing a missing parent into existence is a surprise in the wrong direction: an
 * `ORCH_HOME` typo would be answered by an empty new tree rather than by ENOENT naming the path.
 *
 * The temporary is always removed, on both paths: a lost race leaves the directory as it found it, and
 * a temporary that cannot be removed is inert, because nothing reads a name it was never linked to.
 */
export const createFileExclusively = (path: string, contents: string): boolean => {
  const directory = dirname(path);
  tempCounter += 1;
  // The same directory as the target, because `link(2)` cannot cross a filesystem boundary and a
  // temporary directory elsewhere would fail with EXDEV on exactly the machines that separate them.
  const temp = join(
    directory,
    `${basename(path)}.${String(process.pid)}.${String(tempCounter)}${TEMP_SUFFIX}`,
  );

  /**
   * Written and synced through one descriptor, rather than written and then reopened to sync.
   *
   * A reopened read-only descriptor does reach the same inode, so the previous shape was not wrong —
   * but it is two syscalls and a second chance to name the wrong file, for a durability step whose whole
   * purpose is that the bytes behind the name are already on the platter when the `link` publishes it.
   * 'wx' on the temporary as well: a temporary name that already exists is a collision this process has
   * no business overwriting.
   */
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, contents, null, 'utf8');
    try {
      fsyncSync(fd);
    } catch {
      // Unsynced contents are a durability weakness, not a partial read: the link is still atomic.
    }
  } finally {
    closeSync(fd);
  }

  try {
    linkSync(temp, path);
  } catch (thrown: unknown) {
    discard(temp);
    const errno = errnoOf(thrown);
    if (errno === 'EEXIST') return false;
    if (errno !== null && NO_HARD_LINKS.has(errno)) throw new HardLinksUnsupported(path, errno);
    throw thrown;
  }
  discard(temp);
  // Only now is the *name* durable. Without this the claim can be absent after a power loss while its
  // temporary is already unlinked — the file that decides who may write, lost to a crash it survived.
  fsyncDirectory(directory);
  return true;
};

const discard = (temp: string): void => {
  try {
    unlinkSync(temp);
  } catch {
    // The link is what decided the race; removing the temporary is tidiness and never the result.
  }
};
