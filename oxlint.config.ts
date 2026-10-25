import { defineConfig } from 'oxlint';

export default defineConfig({
  ignorePatterns: [
    '.agent/**', '.agents/**', '.claude/**', '.codex/**', '.continue/**',
    '.cursor/**', '.gemini/**', '.opencode/**', '.pi/**', '.roo/**', '.windsurf/**',
    'tools/oxlint/anti-slop/**',
  ],
  rules: { 'oxc/no-accumulating-spread': 'error' },
});
