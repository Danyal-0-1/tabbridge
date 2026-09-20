import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

describe('passphrase visibility markup', () => {
  for (const [file, expectedFields] of [
    ['src/manager/manager.html', 9],
    ['src/popup/popup.html', 1],
  ] as const) {
    it(`gives every password field an accessible toggle in ${file}`, async () => {
      const html = await readFile(file, 'utf8');
      const passwordInputs = [...html.matchAll(/<input\b[^>]*>/g)]
        .map(([tag]) => tag)
        .filter((tag) => attribute(tag, 'type') === 'password');
      const toggles = [...html.matchAll(/<button\b[^>]*>/g)]
        .map(([tag]) => tag)
        .filter((tag) => tag.includes('data-passphrase-toggle'));

      assert.equal(passwordInputs.length, expectedFields);
      assert.equal(toggles.length, expectedFields);

      const inputIds = passwordInputs.map((tag) => attribute(tag, 'id')).sort();
      const controlledIds = toggles.map((tag) => attribute(tag, 'aria-controls')).sort();
      assert.deepEqual(controlledIds, inputIds);

      for (const toggle of toggles) {
        assert.equal(attribute(toggle, 'type'), 'button');
        assert.equal(attribute(toggle, 'aria-pressed'), 'false');
        assert.match(attribute(toggle, 'aria-label') ?? '', /^Show (?:.+ )?passphrase$/);
      }
    });
  }
});
