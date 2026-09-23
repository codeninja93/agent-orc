/**
 * Story 2-10 — `JiraToolServerSchema` on its own terms: both directions of the half-configured case,
 * a reserved-key `credential_env` refused, and `base_url` held to being an actual URL.
 *
 * **Why this matters beyond the interview's own guard.** AD-16 treats a hand-edited `.orch/profile.toml`
 * as a legitimate path (AD-16), so the schema is the only backstop for a value the interview's own
 * validation never saw. Review pass 1 flagged that nothing exercised `JiraToolServerSchema.safeParse`
 * directly — only the interview's independent guard was exercised, which prevents the bad state before
 * the schema ever sees it.
 */
import { describe, expect, it } from 'vitest';

import { JIRA_RESERVED_ENV_KEYS, JiraToolServerSchema, ProfileSchema } from '../src/contracts/index.js';
import { fixtureProfile } from './helpers/config-fixture.js';

const VALID_URL = 'https://your-domain.atlassian.net';

describe('JiraToolServerSchema — both fields blank together, or both set', () => {
  it('accepts the disabled state: both fields blank', () => {
    const parsed = JiraToolServerSchema.safeParse({ credential_env: '', base_url: '' });
    expect(parsed.success).toBe(true);
  });

  it('accepts a fully configured domain', () => {
    const parsed = JiraToolServerSchema.safeParse({
      credential_env: 'JIRA_API_TOKEN',
      base_url: VALID_URL,
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a name with no base URL (half-configured, one direction)', () => {
    const parsed = JiraToolServerSchema.safeParse({ credential_env: 'JIRA_API_TOKEN', base_url: '' });
    expect(parsed.success).toBe(false);
  });

  it('refuses a base URL with no credential name (half-configured, the other direction)', () => {
    const parsed = JiraToolServerSchema.safeParse({ credential_env: '', base_url: VALID_URL });
    expect(parsed.success).toBe(false);
  });

  it('refuses a base URL that is only whitespace, the same way an empty one is refused', () => {
    const parsed = JiraToolServerSchema.safeParse({
      credential_env: 'JIRA_API_TOKEN',
      base_url: '   ',
    });
    expect(parsed.success).toBe(false);
  });
});

describe('JiraToolServerSchema — a reserved credential_env is refused (review pass 1)', () => {
  it.each(JIRA_RESERVED_ENV_KEYS)('refuses %s, which jiraMcpConfig itself sets', (reserved) => {
    const parsed = JiraToolServerSchema.safeParse({ credential_env: reserved, base_url: VALID_URL });
    expect(parsed.success, `${reserved} should be refused`).toBe(false);
  });

  it('accepts a name that is not one of the reserved keys', () => {
    const parsed = JiraToolServerSchema.safeParse({
      credential_env: 'JIRA_API_TOKEN',
      base_url: VALID_URL,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('JiraToolServerSchema — base_url must be a URL, not a bare string (review pass 1)', () => {
  it('refuses a value with no scheme', () => {
    const parsed = JiraToolServerSchema.safeParse({
      credential_env: 'JIRA_API_TOKEN',
      base_url: 'your-domain.atlassian.net',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a value that is not a URL at all', () => {
    const parsed = JiraToolServerSchema.safeParse({
      credential_env: 'JIRA_API_TOKEN',
      base_url: 'not a url',
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a non-http(s) scheme', () => {
    const parsed = JiraToolServerSchema.safeParse({
      credential_env: 'JIRA_API_TOKEN',
      base_url: 'ftp://your-domain.atlassian.net',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts an ordinary https URL', () => {
    const parsed = JiraToolServerSchema.safeParse({
      credential_env: 'JIRA_API_TOKEN',
      base_url: VALID_URL,
    });
    expect(parsed.success).toBe(true);
  });
});

/**
 * A profile written before story 2-10 has no `tool_servers` key at all, not merely a blank one — the
 * upgrade case `ToolServersSchema`'s own default exists for. Read through the whole `ProfileSchema`,
 * not only the sub-schema, so this proves the default actually reaches a real profile rather than only
 * `JiraToolServerSchema` in isolation.
 */
describe('ProfileSchema — a profile written before this story carries no tool_servers table at all', () => {
  it('parses it and defaults tool_servers.jira to the disabled state, rather than refusing it', () => {
    const { tool_servers: _omitted, ...withoutToolServers } = fixtureProfile();
    expect('tool_servers' in withoutToolServers).toBe(false);

    const parsed = ProfileSchema.safeParse(withoutToolServers);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tool_servers).toStrictEqual({ jira: { credential_env: '', base_url: '' } });
    }
  });
});
