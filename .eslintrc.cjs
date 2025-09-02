module.exports = {
  root: true,
  env: { node: true, es2022: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', project: false },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'prettier'
  ],
  rules: {
    'import/order': ['error', { 'newlines-between': 'always', groups: [['builtin', 'external'], 'internal', ['parent', 'sibling', 'index']] }]
  },
  ignorePatterns: ['dist', 'node_modules']
};
