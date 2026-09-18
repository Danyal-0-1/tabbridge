import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const requested = process.argv[2];
if (!requested) throw new Error('Pass a test directory.');

async function findTests(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...(await findTests(item)));
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) results.push(item);
  }
  return results.sort();
}

const tests = await findTests(requested);
if (tests.length === 0) throw new Error(`No tests found under ${requested}.`);
const temporary = await mkdtemp(path.join(os.tmpdir(), 'tabbridge-tests-'));
try {
  const outputs = [];
  for (const [index, test] of tests.entries()) {
    const output = path.join(temporary, `${index}-${path.basename(test, '.ts')}.mjs`);
    await build({
      entryPoints: [test],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'warning',
    });
    outputs.push(output);
  }
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...outputs], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
