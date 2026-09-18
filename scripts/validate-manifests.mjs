import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const approvedPermissions = ['storage', 'tabGroups', 'tabs'];

function equalSet(left, right) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertFile(directory, relative) {
  await access(path.join(directory, relative));
}

for (const browser of ['chrome', 'firefox']) {
  const directory = path.join('dist', browser);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert(manifest.manifest_version === 3, `${browser}: manifest_version must be 3.`);
  assert(manifest.name === 'TabBridge', `${browser}: unexpected name.`);
  assert(manifest.version === packageJson.version, `${browser}: version mismatch.`);
  assert(
    equalSet(manifest.permissions ?? [], approvedPermissions),
    `${browser}: permissions must be exactly tabs, tabGroups, and storage.`,
  );
  assert(manifest.incognito === 'not_allowed', `${browser}: incognito must be disabled.`);
  for (const forbidden of [
    'host_permissions',
    'optional_host_permissions',
    'content_scripts',
    'externally_connectable',
    'oauth2',
    'update_url',
  ]) {
    assert(!(forbidden in manifest), `${browser}: forbidden manifest key ${forbidden}.`);
  }
  assert(
    !('key' in manifest),
    `${browser}: production manifest must not contain a development key.`,
  );
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  assert(csp.includes("script-src 'self'"), `${browser}: strict script CSP missing.`);
  assert(csp.includes("object-src 'none'"), `${browser}: object CSP missing.`);
  assert(csp.includes("connect-src 'none'"), `${browser}: network CSP missing.`);

  await Promise.all([
    assertFile(directory, 'background.js'),
    assertFile(directory, 'popup.html'),
    assertFile(directory, 'popup.js'),
    assertFile(directory, 'manager.html'),
    assertFile(directory, 'manager.js'),
    ...Object.values(manifest.icons).map((icon) => assertFile(directory, icon)),
  ]);

  if (browser === 'chrome') {
    assert(manifest.minimum_chrome_version === '90', 'Chrome minimum must be 90.');
    assert(
      manifest.background?.service_worker === 'background.js' &&
        !('scripts' in manifest.background),
      'Chrome must use only a service worker.',
    );
    assert(
      !('browser_specific_settings' in manifest),
      'Chrome manifest contains Firefox settings.',
    );
  } else {
    assert(
      Array.isArray(manifest.background?.scripts) &&
        manifest.background.scripts[0] === 'background.js' &&
        !('service_worker' in manifest.background),
      'Firefox must use only background.scripts.',
    );
    const gecko = manifest.browser_specific_settings?.gecko;
    assert(
      !('gecko_android' in manifest.browser_specific_settings),
      'Firefox must not advertise untested Android compatibility.',
    );
    assert(gecko?.id === '{bf90e8ec-cdc7-4385-9bd9-19cac28c37c0}', 'Firefox ID changed.');
    assert(gecko?.strict_min_version === '140.0', 'Firefox minimum must be 140.');
    assert(
      equalSet(gecko?.data_collection_permissions?.required ?? [], ['none']),
      'Firefox required data collection declaration changed.',
    );
    assert(
      equalSet(gecko?.data_collection_permissions?.optional ?? [], [
        'browsingActivity',
        'websiteContent',
        'technicalAndInteraction',
        'personallyIdentifyingInfo',
      ]),
      'Firefox optional sync consent categories changed.',
    );
  }

  const files = await readdir(directory, { recursive: true });
  for (const file of files) {
    assert(!file.endsWith('.map'), `${browser}: source map included: ${file}`);
    assert(!file.endsWith('.ts'), `${browser}: TypeScript source included: ${file}`);
    assert(
      !/(?:^|\/)(?:tests?|docs?|\.github)(?:\/|$)/.test(file),
      `${browser}: dev file included: ${file}`,
    );
    assert(!/\.(?:pem|key|env)$/i.test(file), `${browser}: secret-like file included: ${file}`);
  }
}

process.stdout.write('Chrome and Firefox manifests/packages passed semantic validation.\n');
