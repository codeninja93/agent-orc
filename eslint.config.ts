import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'docs/**', '_bmad/**', '.claude/**'],
  },
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Consistency Conventions: no unit writes diagnostics to stdout.
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      // JSON Schema and manifest objects are read through index signatures on purpose;
      // bracket access is the honest spelling for a key that is not a known property.
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      // `const { field: _omitted, ...rest } = x` is how a test builds an artifact missing a field.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
