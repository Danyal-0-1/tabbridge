import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { build } from 'esbuild';

const root = process.cwd();
const requested = process.argv[2];
const targets = requested ? [requested] : ['chrome', 'firefox'];

if (targets.some((target) => !['chrome', 'firefox'].includes(target))) {
  throw new Error('Build target must be chrome or firefox.');
}

for (const target of targets) {
  const output = path.join(root, 'dist', target);
  await rm(output, { recursive: true, force: true });
  await mkdir(path.join(output, 'icons'), { recursive: true });

  await build({
    entryPoints: {
      background: path.join(root, 'src/background/service.ts'),
      popup: path.join(root, 'src/popup/main.ts'),
      manager: path.join(root, 'src/manager/main.ts'),
    },
    outdir: output,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: target === 'chrome' ? ['chrome90'] : ['firefox140'],
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    charset: 'utf8',
    logLevel: 'warning',
  });

  await Promise.all([
    build({
      entryPoints: [path.join(root, 'src/popup/popup.css')],
      outfile: path.join(output, 'styles-popup.css'),
      bundle: true,
      minify: true,
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'warning',
    }),
    build({
      entryPoints: [path.join(root, 'src/manager/manager.css')],
      outfile: path.join(output, 'styles-manager.css'),
      bundle: true,
      minify: true,
      sourcemap: false,
      legalComments: 'none',
      logLevel: 'warning',
    }),
  ]);

  const popupHtml = (await readFile(path.join(root, 'src/popup/popup.html'), 'utf8')).replace(
    'href="styles.css"',
    'href="styles-popup.css"',
  );
  const managerHtml = (await readFile(path.join(root, 'src/manager/manager.html'), 'utf8')).replace(
    'href="styles.css"',
    'href="styles-manager.css"',
  );
  await Promise.all([
    writeFile(path.join(output, 'popup.html'), popupHtml),
    writeFile(path.join(output, 'manager.html'), managerHtml),
    cp(path.join(root, 'manifests', `${target}.json`), path.join(output, 'manifest.json')),
  ]);
  for (const size of [16, 32, 48, 128]) {
    await cp(
      path.join(root, 'public/icons', `icon-${size}.png`),
      path.join(output, 'icons', `icon-${size}.png`),
    );
  }
}
