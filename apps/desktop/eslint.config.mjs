// ESLint v9 flat config for the Tauri React 19 + TS frontend.
// Linting goal: no implicit any, no unused vars (excluding the underscore
// convention), exhaustive-deps for hooks, react-refresh component-export
// hygiene. Anything stricter than this slows iteration without payoff.

import js from '@eslint/js';
import tsPlugin from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tsPlugin.config(
  // 1. Base JS rules
  js.configs.recommended,

  // 2. Type-aware TS rules (no parserServices — strict project parsing not
  //    needed since `tsc -b` already typechecks the whole graph).
  ...tsPlugin.configs.recommended,

  // 3. Project-wide settings
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // Allow `_foo` for intentionally unused params/vars.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // We use plain `any` deliberately for Tauri IPC payloads / external
      // JSON shapes that aren't worth modelling. Warn, don't error.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Empty object types are fine for marker types and React props.
      '@typescript-eslint/no-empty-object-type': 'off',

      // The route file uses `as any` to convert TanStack Router types.
      '@typescript-eslint/ban-ts-comment': ['warn', { 'ts-ignore': false, 'ts-expect-error': false }],
    },
  },

  // 4. Generated / vendor — ignore
  {
    ignores: [
      'dist/**',
      'src-tauri/**',
      'src/routeTree.gen.ts',
      'src/components/ui/**', // shadcn/ui untouched
      '**/*.config.{js,mjs,ts,cjs}',
      '**/.tsbuildinfo-*/**',
    ],
  },
);
