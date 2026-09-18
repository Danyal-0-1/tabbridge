import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const tag = process.argv[2];
if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+$/.test(tag)) {
  throw new Error('Release tag must be strict vMAJOR.MINOR.PATCH semver.');
}
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
if (tag !== `v${packageJson.version}`) {
  throw new Error(`Tag ${tag} does not match package version ${packageJson.version}.`);
}
for (const browser of ['chrome', 'firefox']) {
  const manifest = JSON.parse(await readFile(path.join('dist', browser, 'manifest.json'), 'utf8'));
  if (manifest.version !== packageJson.version) {
    throw new Error(`${browser} manifest version does not match ${packageJson.version}.`);
  }
  await readFile(path.join('artifacts', `tabbridge-${browser}-${tag}.zip`));
}
const changelog = await readFile('CHANGELOG.md', 'utf8');
const section = changelog.match(
  new RegExp(`## \\[${packageJson.version.replaceAll('.', '\\.')}\\][\\s\\S]*?(?=\\n## \\[|$)`),
);
if (!section) throw new Error(`CHANGELOG.md has no ${packageJson.version} section.`);
const notes = `${section[0].trim()}\n\n## Installation\n\n- Chrome: download the Chrome ZIP, extract it, enable Developer mode at chrome://extensions, and load the extracted directory. Store publication is a separate human-reviewed step.\n- Firefox: the ZIP is suitable for temporary testing or AMO submission; normal permanent installation requires Mozilla signing.\n\n## Known limitations\n\nDesktop only. Browser-account sync stays within one browser ecosystem, is eventually consistent, and does not confirm remote delivery. Chrome↔Firefox transfer uses an encrypted .tabbridge file. Restores cannot reproduce cookies, logins, form data, page memory, scroll/media state, full history, or closed Saved Tab Groups.\n`;
await writeFile(path.join('artifacts', 'RELEASE_NOTES.md'), notes);
process.stdout.write(`Release assets validated for ${tag}.\n`);
