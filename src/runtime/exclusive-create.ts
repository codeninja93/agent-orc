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
 * `fsync` it, then `link(2)` it to the real name. `link` is the same atomic test-and-set — the second
 * linker gets `EEXIST`, on every filesystem this runs on — but the inode it publishes already holds the
 * whole record. So a reader sees the claim complete or sees no claim. `rename` would not do: it
 * replaces the target, so it decides nothing.
 *
 * `EEXIST` is the only failure that means "somebody else holds it". `EACCES`, `ENOSPC` and `EROFS` say
 * nothing about a holder, and reporting one of them as a lost race would tell a user that a disk fault
 * was another engine.
 *
 * It lives in `src/runtime/` because both call sites need it and the dependency direction only allows
 * one of them to import the other: the recorder's writer claim is here, the AD-30 engine lock is in
 * `src/engine/`, and the engine may depend on the runtime. `src/engine/questions.ts` keeps its own copy
 * of the idiom, which this one is deliberately identical in shape to; unifying them would edit story
 * 1-8's compare-and-set, which is not this story's subject.
 */
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Distinguishes this process's temporaries from a concurrent one's, and one call's from the next. */
let tempCounter = 0;

const TEMP_SUFFIX = '.tmp';

/**
 * Create `path` holding `contents`, or answer `false` because another process created it first.
 *
 * The temporary is always removed, on both paths: a lost race leaves the directory as it found it, and
 * a temporary that cannot be removed is inert, because nothing reads a name it was never linked to.
 */
export const createFileExclusively = (path: string, contents: string): boolean => {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  tempCounter += 1;
  // The same directory as the target, because `link(2)` cannot cross a filesystem boundary and a
  // temporary directory elsewhere would fail with EXDEV on exactly the machines that separate them.
  const temp = join(
    directory,
    `${basenameOf(path)}.${String(process.pid)}.${String(tempCounter)}${TEMP_SUFFIX}`,
  );
  writeFileSync(temp, contents, 'utf8');
  const fd = openSync(temp, 'r');
  try {
    fsyncSync(fd);
  } catch {
    // Unsynced contents are a durability weakness, not a partial read: the link is still atomic.
  }
  closeSync(fd);

  try {
    linkSync(temp, path);
  } catch (thrown: unknown) {
    discard(temp);
    if ((thrown as { code?: string } | null)?.code === 'EEXIST') return false;
    throw thrown;
  }
  discard(temp);
  return true;
};

/** The final path segment, used only to make a temporary recognisable beside its target. */
const basenameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

const discard = (temp: string): void => {
  try {
    unlinkSync(temp);
  } catch {
    // The link is what decided the race; removing the temporary is tidiness and never the result.
  }
};
