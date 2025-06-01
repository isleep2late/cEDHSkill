import path from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import typescriptEslintParser from '@typescript-eslint/parser';
// eslint-disable-next-line import/no-extraneous-dependencies -- Used for type information and config structure
import typescriptEslintPlugin from '@typescript-eslint/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import unicornPlugin from 'eslint-plugin-unicorn';
import globals from 'globals';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default [
    // 1. Global ignores
    {
        ignores: [
            '.cache/',
            '.git/',
            'dist/',
            'docs/',
            'misc/',
            'node_modules/',
            'temp/',
            'eslint.config.js',
        ],
    },

    // 2. Base ESLint recommended rules
    js.configs.recommended,

    // 3. TypeScript Specific Configuration
    {
        files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
        languageOptions: {
            parser: typescriptEslintParser,
            parserOptions: {
                project: ['./tsconfig.eslint.json'],
                tsconfigRootDir: __dirname,
                ecmaVersion: 'latest',
                sourceType: 'module',
            },
            globals: {
                ...globals.node,
            },
        },
        plugins: {
            '@typescript-eslint': typescriptEslintPlugin,
        },
        rules: {
            ...(typescriptEslintPlugin.configs.recommended?.rules || {}),
            ...(typescriptEslintPlugin.configs['recommended-type-checked']?.rules || {}),
            '@typescript-eslint/explicit-function-return-type': [
                'error',
                { allowExpressions: true },
            ],
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-floating-promises': 'off',
            '@typescript-eslint/no-inferrable-types': ['error', { ignoreParameters: true }],
            '@typescript-eslint/no-misused-promises': 'off',
            '@typescript-eslint/no-unsafe-argument': 'off',
            '@typescript-eslint/no-unsafe-assignment': 'off',
            '@typescript-eslint/no-unsafe-call': 'off',
            '@typescript-eslint/no-unsafe-enum-comparison': 'off',
            '@typescript-eslint/no-unsafe-member-access': 'off',
            '@typescript-eslint/no-unsafe-return': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                },
            ],
            '@typescript-eslint/no-var-requires': 'off',
            '@typescript-eslint/only-throw-error': 'off',
            '@typescript-eslint/require-await': 'off',
            '@typescript-eslint/restrict-template-expressions': 'off',
            '@typescript-eslint/return-await': ['error', 'always'],
            '@typescript-eslint/typedef': ['error', { parameter: true, propertyDeclaration: true }],
            '@typescript-eslint/unbound-method': 'off',
        },
    },

    // 4. ESLint Plugin Import configurations
    {
        files: ['**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx', '**/*.mjs', '**/*.cjs'],
        plugins: {
            import: importPlugin,
        },
        settings: {
            'import/resolver': {
                typescript: {
                    alwaysTryTypes: true,
                    project: './tsconfig.eslint.json', // Point to your tsconfig for linting
                },
                node: true,
            },
            'import/parsers': {
                '@typescript-eslint/parser': ['.ts', '.tsx', '.mts', '.cts'],
            },
        },
        rules: {
            ...(importPlugin.configs.recommended?.rules || {}),
            ...(importPlugin.configs.typescript?.rules || {}),
            'import/extensions': [
                'error',
                'ignorePackages',
                {
                    js: 'never',
                    mjs: 'never',
                    jsx: 'never',
                    ts: 'never',
                    tsx: 'never',
                },
            ],
            'import/no-extraneous-dependencies': 'error',
            'import/no-unresolved': 'off', // Resolver should handle this; turn off if it causes issues with TS paths
            'import/no-useless-path-segments': 'error',
            'import/order': [
                'error',
                {
                    alphabetize: { caseInsensitive: true, order: 'asc' },
                    groups: [
                        ['builtin', 'external', 'object', 'type'],
                        ['internal', 'parent', 'sibling', 'index'],
                    ],
                    'newlines-between': 'always',
                },
            ],
        },
    },

    // 5. ESLint Plugin Unicorn configurations
    {
        files: ['**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx', '**/*.mjs', '**/*.cjs'],
        plugins: {
            unicorn: unicornPlugin,
        },
        rules: {
            // You can spread recommended Unicorn rules here if desired:
            // ...(unicornPlugin.configs['flat/recommended']?.rules || {}),
            'unicorn/prefer-node-protocol': 'error',
        },
    },

    // 6. Global ESLint rule overrides
    {
        rules: {
            'no-return-await': 'off',
            'no-unused-vars': 'off',
            'prefer-const': 'off',
            quotes: ['error', 'single', { allowTemplateLiterals: true }],
            'sort-imports': 'off', // Covered by import/order
        },
    },
];
