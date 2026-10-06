import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['build/**', 'node_modules/**', 'evidence/**', '.stage0/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
