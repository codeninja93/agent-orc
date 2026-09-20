# The tier-2 executor image (AD-11, AD-20, CAP-10).
#
# Built locally, tagged with this file's content hash by `src/container/image.ts`, and never pulled
# from a registry. The hash is the identity: change one line here and the next run builds a new image
# rather than reusing a sandbox that no longer matches its definition.
#
# Four properties this file is responsible for, and what each one prevents:
#
#   * A pinned base. `node:24.21.0-bookworm-slim` rather than `node:24` or `node:lts`, so the same
#     Dockerfile hash always means the same sandbox. A floating base tag would make the content hash a
#     lie — identical bytes here, a different image on two machines.
#   * A non-root user, created with the exact uid:gid `src/container/flags.ts` passes to `--user`
#     (10001:10001). The AD-31 suite asserts `id -u` is not 0 from inside a running container.
#   * The step toolchain and nothing else: node (from the base), git, and the `claude` CLI at
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

# The uid:gid `--user` is given. Kept identical to EXECUTOR_UID/EXECUTOR_GID in src/container/flags.ts;
# a mismatch would leave the container running as a uid with no passwd entry and no writable home.
ARG EXECUTOR_UID=10001
ARG EXECUTOR_GID=10001
ARG EXECUTOR_USER=orch

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

RUN groupadd --gid "${EXECUTOR_GID}" "${EXECUTOR_USER}" \
  && useradd --uid "${EXECUTOR_UID}" --gid "${EXECUTOR_GID}" --home-dir /home/"${EXECUTOR_USER}" \
    --create-home --shell /bin/bash "${EXECUTOR_USER}"

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
USER ${EXECUTOR_UID}:${EXECUTOR_GID}

# No ENTRYPOINT: the wrapper composes the full command line (the image's own CLI plus story 1-4's
# unchanged AD-1 argv), and an entry point that wrapped it would be a second place the invocation is
# defined — which is exactly what AD-20 gives one wrapper sole ownership to prevent.
CMD ["/usr/local/bin/claude", "--version"]
