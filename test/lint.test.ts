import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ESLint } from 'eslint';

const eslint = new ESLint({ flags: ['unstable_native_nodejs_ts_config'] });

async function findings(code: string) {
  const [result] = await eslint.lintText(code, { filePath: 'lint-fixture.ts' });

  return result.messages.map(message => message.ruleId);
}

test('anti-slop preserves assertion offsets and safety comments through the parser adapter', async () => {
  assert.ok((await findings('const value = 1 as number;')).includes('anti-slop/require-safety-comment-for-type-assertion'));
  assert.deepEqual(await findings('// SAFETY: the literal is a number.\nconst value = 1 as number;'), []);
});

test('anti-slop rejects ad hoc typeof checks but permits explicit boundary predicates', async () => {
  assert.ok((await findings("function text(value: string | number) { return typeof value === 'string'; }")).includes('anti-slop/no-runtime-typeof'));
  assert.deepEqual(await findings("function isText(value: unknown): value is string { return typeof value === 'string'; }"), []);
});
