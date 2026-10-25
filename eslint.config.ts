import parser from '@typescript-eslint/parser';
import antiSlop from './tools/oxlint/anti-slop/index.ts';
import oxlint from './oxlint.config.ts';

type Ranged = { range: [number, number] };

function hasRange(value: unknown): value is Ranged {
  return value !== null && typeof value === 'object' && 'range' in value &&
    Array.isArray(value.range) && value.range.length === 2 && value.range.every(Number.isInteger);
}

// Anti-slop uses Oxc offsets. typescript-eslint exposes the same offsets as range pairs.
function addOffsets(node: Ranged) {
  Object.assign(node, { start: node.range[0], end: node.range[1] });

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (hasRange(child)) addOffsets(child);
    } else if (hasRange(value)) addOffsets(value);
  }
}

export default [
  { ignores: oxlint.ignorePatterns },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: {
        parseForESLint(...args: Parameters<typeof parser.parseForESLint>) {
          const parsed = parser.parseForESLint(...args);
          addOffsets(parsed.ast);

          return parsed;
        },
      },
    },
    plugins: { 'anti-slop': antiSlop },
    rules: {
      'anti-slop/no-array-filter-map': 'error',
      'anti-slop/no-reduce-accumulator-copy': 'error',
      'anti-slop/no-chained-type-assertions': 'error',
      'anti-slop/no-conditional-empty-object-spread': 'error',
      'anti-slop/no-known-value-widening': 'error',
      'anti-slop/no-module-mocking': 'error',
      'anti-slop/no-object-parameters': 'error',
      'anti-slop/no-reflect-apply': 'error',
      'anti-slop/no-reflect-get': 'error',
      'anti-slop/no-runtime-typeof': ['error', { allowInTypeGuards: true }],
      'anti-slop/no-shape-in-symbol-names': 'error',
      'anti-slop/no-unknown-parameters': 'error',
      'anti-slop/no-unknown-returns': 'error',
      'anti-slop/no-unknown-type-aliases': 'error',
      'anti-slop/no-unsafe-dictionary-type': 'error',
      'anti-slop/no-widen-then-assert': 'error',
      'anti-slop/require-readable-spacing': 'error',
      'anti-slop/require-safety-comment-for-type-assertion': 'error',
    },
  },
];
