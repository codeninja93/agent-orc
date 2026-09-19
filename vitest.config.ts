import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // AD-31: the contract suites are the verification floor; failures must be loud.
    passWithNoTests: false,
  },
});
