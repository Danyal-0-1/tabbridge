import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const roots = ['src', 'scripts', 'tests', 'manifests'];
const textExtensions = new Set(['.ts', '.mjs', '.json', '.html', '.css']);
const unresolvedTaskMarker = new RegExp(`\\b(?:TO${'DO'}|FIX${'ME'})\\b`);
const rules = [
  { pattern: /\.innerHTML\s*=/, message: 'Use textContent/DOM construction instead of innerHTML.' },
  { pattern: /\beval\s*\(/, message: 'eval is forbidden.' },
  { pattern: /\bnew\s+Function\s*\(/, message: 'Dynamic Function construction is forbidden.' },
  { pattern: /\bfetch\s*\(/, message: 'Runtime network requests are forbidden.' },
  { pattern: /\bXMLHttpRequest\b/, message: 'Runtime network requests are forbidden.' },
  { pattern: /\bWebSocket\s*\(/, message: 'Runtime network requests are forbidden.' },
  { pattern: /\bEventSource\s*\(/, message: 'Runtime network requests are forbidden.' },
  { pattern: /\bsendBeacon\s*\(/, message: 'Runtime network requests are forbidden.' },
  {
    pattern: unresolvedTaskMarker,
    message: 'Release code must not contain unresolved task markers.',
  },
];

async function filesUnder(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...(await filesUnder(item)));
    else if (entry.isFile() && textExtensions.has(path.extname(item))) results.push(item);
  }
  return results;
}

const failures = [];
for (const root of roots) {
  for (const file of await filesUnder(root)) {
    const contents = await readFile(file, 'utf8');
    for (const rule of rules) {
      if (rule.pattern.test(contents)) failures.push(`${file}: ${rule.message}`);
    }
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Static security and source-policy lint passed.\n');
}
