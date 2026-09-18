import { readFile } from 'node:fs/promises';
import process from 'node:process';
import addonsLinter from 'addons-linter';

const manifest = JSON.parse(await readFile('dist/firefox/manifest.json', 'utf8'));
const gecko = manifest.browser_specific_settings?.gecko;

if (manifest.browser_specific_settings?.gecko_android !== undefined) {
  throw new Error('The Firefox package must not advertise untested Android compatibility.');
}

if (gecko?.strict_min_version !== '140.0') {
  throw new Error('The Firefox desktop minimum must remain 140.0.');
}

const linter = addonsLinter.createInstance({
  config: {
    _: ['dist/firefox'],
    logLevel: 'fatal',
    stack: false,
    pretty: false,
    warningsAsErrors: false,
    metadata: false,
    output: 'none',
    boring: true,
    selfHosted: false,
    shouldScanFile: () => true,
  },
  runAsBinary: false,
});
const report = await linter.run();
const allowedWarning = 'KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION';
const unexpectedWarnings = report.warnings.filter(
  (warning) => warning.code !== allowedWarning || warning.file !== 'manifest.json',
);

if (report.errors.length > 0 || report.notices.length > 0 || unexpectedWarnings.length > 0) {
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  throw new Error('Firefox lint reported a non-allowlisted finding.');
}

if (report.warnings.length > 1) {
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
  throw new Error('Firefox lint reported more than the single upstream Android warning.');
}

const suffix =
  report.warnings.length === 1 ? ' (one allowlisted upstream Android-inference warning)' : '';
process.stdout.write(`Firefox package passed web-ext lint${suffix}.\n`);
