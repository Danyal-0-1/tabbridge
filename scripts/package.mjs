import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { deterministicZip } from './zip.mjs';

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const artifacts = path.join(root, 'artifacts');
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });

const checksumLines = [];
for (const browser of ['chrome', 'firefox']) {
  const filename = `tabbridge-${browser}-v${packageJson.version}.zip`;
  const archive = await deterministicZip(path.join(root, 'dist', browser));
  await writeFile(path.join(artifacts, filename), archive);
  const digest = createHash('sha256').update(archive).digest('hex');
  const line = `${digest}  ${filename}\n`;
  await writeFile(path.join(artifacts, `${filename}.sha256`), line);
  checksumLines.push(line);
}
await writeFile(path.join(artifacts, 'SHA256SUMS'), checksumLines.join(''));
