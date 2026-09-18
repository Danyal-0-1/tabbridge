import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { deterministicZip } from './zip.mjs';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'tabbridge-package-'));
try {
  for (const browser of ['chrome', 'firefox']) {
    const expected = await readFile(
      path.join('artifacts', `tabbridge-${browser}-v${packageJson.version}.zip`),
    );
    const rebuilt = await deterministicZip(path.join('dist', browser));
    const expectedHash = createHash('sha256').update(expected).digest('hex');
    const rebuiltHash = createHash('sha256').update(rebuilt).digest('hex');
    if (expectedHash !== rebuiltHash) {
      throw new Error(`${browser} package is not reproducible.`);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
process.stdout.write('Release packages are reproducible and match dist.\n');
