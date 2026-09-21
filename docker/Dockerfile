# The tier-2 executor image (AD-11, AD-20, CAP-10).
#
# Built locally, tagged with this file's content hash by `src/container/image.ts`, and never pulled
# from a registry. The hash is the identity: change one line here and the next run builds a new image
# rather than reusing a sandbox that no longer matches its definition.
#
# Four properties this file is responsible for, and what each one prevents:
#
#   * A pinned base. `node:24.21.0-bookworm-slim` rather than `node:24` or `node:lts`, so the base layer
#     cannot float behind an unchanged hash. What the hash guarantees is bounded and worth stating
#     exactly: the same hash means the same *definition* — the same base digest resolved by tag, the same
#     uid, the same flags, the same pinned CLI version. It does not mean a byte-identical image, because
#     `apt-get install` resolves whatever the Debian archive serves that day and `npm install --global`
#     resolves the CLI's transitive dependencies at build time. Reproducing an image exactly would need
#     a digest-pinned base, pinned `.deb` versions and a lockfile; none of those is here, so the claim
#     is not made.
#   * A non-root user, created with the exact uid:gid `src/container/flags.ts` passes to `--user`
#     (10001:10001), spelled literally rather than through a build argument: the tag is this file's
#     content hash, so a value that could be overridden at build time is a value the identity does not
#     cover. `tests/container.image.test.ts` asserts the literals here equal EXECUTOR_UID,
#     EXECUTOR_GID and CONTAINER_HOME, and the AD-31 suite asserts `id -u` and `id -un` from inside a
#     running container.
#   * The step toolchain and nothing else: node (from the base), git, ripgrep, and the `claude` CLI at
#     /usr/local/bin/claude, which is the absolute path `wrapper.ts` runs. Nothing is fetched at run
#     time, because execution has no general network (AD-20's two-phase sandbox).
#   * No credential of any kind. No ARG carrying a token, no COPY of a config file, no ssh key, no
#     registry login, no git credential helper. AD-20 gives the executor no push credential and no
#     production credential; only the gated committer may push. A credential baked in here would be in
#     every layer of every container this system ever runs.
#
# The build is the only step permitted network access outside the egress allowlist (AD-11), which is
# why apt and npm appear here and nowhere in the run path.

FROM node:24.21.0-bookworm-slim

# The CLI version. The Stack table's floor is >=2.1.259; this is the version story 1-4 verified its
# flag behaviour against. Pinned, for the same reason the base image is.
ARG CLAUDE_CLI_VERSION=2.1.278

# git is the step toolchain's other half: AD-26 baselines and AD-22 notes are git operations, and a
# step that cannot read `git log` cannot re-ground itself. ca-certificates is for the provisioning
# phase. `--no-install-recommends` keeps the surface to what is named.
RUN apt-get update \
  && apt-get install --no-install-recommends --yes \
    ca-certificates \
    git \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

# The uid:gid `--user` is given, and the home directory `HOME` below names. Literal, and identical to
# EXECUTOR_UID/EXECUTOR_GID/CONTAINER_HOME in src/container/flags.ts: a mismatch leaves the container
# running as a uid with no passwd entry, where `id -un` fails and git has no identity to work from.
RUN groupadd --gid 10001 orch \
  && useradd --uid 10001 --gid 10001 --home-dir /home/orch \
    --create-home --shell /bin/bash orch

# Installed globally so the entry point is the absolute /usr/local/bin/claude that wrapper.ts runs:
# a read-only root and a --restricted CLI are not a place to depend on PATH resolution.
RUN npm install --global --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}" \
  && npm cache clean --force \
  && test -x /usr/local/bin/claude \
  && test -x /usr/local/bin/node

# Run-time environment. HOME is a tmpfs mount at run time (flags.ts), so nothing written here persists
# and nothing of the host's is visible. No credential, no token, no registry configuration.
ENV HOME=/home/orch \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    CI=true

# Belt to the run-time braces: the container also runs with --user, --read-only, --cap-drop=ALL,
# no-new-privileges, a seccomp profile, memory and pid limits, and --network none.
USER 10001:10001

# No ENTRYPOINT: the wrapper composes the full command line (the image's own CLI plus story 1-4's
# unchanged AD-1 argv), and an entry point that wrapped it would be a second place the invocation is
# defined — which is exactly what AD-20 gives one wrapper sole ownership to prevent.
CMD ["/usr/local/bin/claude", "--version"]
