// ESLint "flat config": an array of config objects applied in order.
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules/', 'coverage/'] },
  eslint.configs.recommended,
  // Type-aware rules (e.g. no-floating-promises) need the TypeScript project, see parserOptions.
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Convention: a leading underscore marks a parameter that must exist but is unused
      // (e.g. `_next` in an Express error handler, which needs exactly 4 parameters).
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
