import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'data/**', '.release-validation/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['scripts/*.mjs', 'examples/*.mjs'], languageOptions: { globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', AbortSignal: 'readonly', AbortController: 'readonly', Buffer: 'readonly', URL: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' } } },
);
