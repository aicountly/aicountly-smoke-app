#!/usr/bin/env node
// LEGACY — for the RETIRED shared worker host only.
//
// Smoke jobs are now served by the worker on the portal's own cPanel account
// (${PROD_REMOTE_ROOT}/worker, PM2 process aicountly-smoke-worker), which the
// deploy workflow builds, rsyncs and restarts. Nothing in that path uses this
// script; it is kept only for reference / a fallback to the old host.
//
// Builds an upload bundle for the shared multi-portal worker host
// (worker.apis.aicountly.com), which runs TypeScript through tsx from
// portals/smoke/ rather than this repo's compiled worker/dist.
//
// portals/smoke/<path> is a 1:1 mirror of worker/src/<path>, so the whole tree
// is always emitted. Hand-picked subsets are how the live worker ends up with a
// new runSession.ts importing helpers that were never uploaded.
//
//   node worker/scripts/pack-apis-bundle.mjs <bundle-name> [--no-zip]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2).filter((a) => a !== '--');
const wantZip = !args.includes('--no-zip');
const rawName = args.find((a) => !a.startsWith('-'));

if (!rawName) {
  console.error('Usage: npm run worker:pack -- <bundle-name> [--no-zip]');
  console.error('Example: npm run worker:pack -- login-hostguard-20260729');
  process.exit(1);
}

const name = rawName.replace(/[^a-zA-Z0-9._-]/g, '-');
const bundleRoot = path.join(repoRoot, 'deploy', 'worker-apis-upload', name);
const uploadRoot = path.join(bundleRoot, 'files-to-upload');
const portalRoot = path.join(uploadRoot, 'worker', 'portals', 'smoke');

if (fs.existsSync(bundleRoot)) {
  fs.rmSync(bundleRoot, { recursive: true });
}

/** @returns {string[]} repo-relative paths, sorted */
function collect(dir, filter) {
  const out = [];
  const walk = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (filter(child)) out.push(path.relative(repoRoot, child));
    }
  };
  walk(dir);
  return out;
}

function copyInto(relFrom, absTo) {
  fs.mkdirSync(path.dirname(absTo), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, relFrom), absTo);
}

const srcFiles = collect(
  path.join(repoRoot, 'worker', 'src'),
  (abs) => abs.endsWith('.ts') && !abs.endsWith('.test.ts'),
);

for (const rel of srcFiles) {
  const inner = path.relative(path.join(repoRoot, 'worker', 'src'), path.join(repoRoot, rel));
  copyInto(rel, path.join(portalRoot, inner));
}

// File I/O sessions read samples/fixtures/manifest.json from the worker's repoRoot.
const fixtureDir = path.join(repoRoot, 'samples', 'fixtures');
const fixtureFiles = fs.existsSync(fixtureDir) ? collect(fixtureDir, () => true) : [];
for (const rel of fixtureFiles) {
  copyInto(rel, path.join(uploadRoot, rel));
}

const workerPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'worker', 'package.json'), 'utf8'));
const deps = Object.entries(workerPkg.dependencies ?? {});

const manifest = [
  `# ${name}`,
  '',
  `Generated: ${new Date().toISOString()}`,
  `Source: worker/src (${srcFiles.length} files, tests excluded)`,
  '',
  '## Destination',
  '',
  'Host: worker.apis.aicountly.com',
  'App root: /home/apisaicountly/public_html/worker.apis.aicountly.com/',
  '',
  '| Bundle path | Server path |',
  '|---|---|',
  '| `files-to-upload/worker/portals/smoke/` | `portals/smoke/` (replace whole folder) |',
  fixtureFiles.length ? '| `files-to-upload/samples/fixtures/` | `samples/fixtures/` (File I/O sessions) |' : '',
  '',
  '## Runtime dependencies expected by this build',
  '',
  ...deps.map(([dep, range]) => `- ${dep} ${range}`),
  '',
  'The live host keeps its own `package.json` (`start: tsx index.ts`) and `.env`.',
  'This bundle deliberately ships neither. If a dependency above is missing there,',
  'run `npm install <dep>` on that host before restarting.',
  '',
  '## Files',
  '',
  ...srcFiles.map((rel) => `- portals/smoke/${path.relative(path.join('worker', 'src'), rel).split(path.sep).join('/')}`),
  '',
].filter((line) => line !== '');

fs.writeFileSync(path.join(bundleRoot, 'MANIFEST.md'), `${manifest.join('\n')}\n`);

fs.writeFileSync(
  path.join(bundleRoot, 'UPLOAD-VIA-CPANEL.md'),
  `# Upload ${name} to worker.apis.aicountly.com

Replace the **entire** \`portals/smoke\` folder. Uploading individual files leaves
a mixed build: new modules import helpers that are not there and the worker dies
on boot, or an old module silently keeps serving the bug you just fixed.

1. cPanel File Manager → \`public_html/worker.apis.aicountly.com/\`
2. Upload \`files-to-upload/worker/portals/smoke/\` over \`portals/smoke/\`
   (or upload the zip, extract, then move the folder into place)
3. Leave \`.env\` and \`package.json\` untouched
4. Restart, because PM2 holds the old process in memory:

\`\`\`bash
cd ~/public_html/worker.apis.aicountly.com
pm2 restart aicountly-qa-worker || pm2 restart qa-worker || pm2 restart smoke-worker
pm2 logs --lines 60
\`\`\`

## Verify the new build is live

Fresh-run log lines that only exist in this build:

- \`Jump To: product="<product>" → "<label>"\` — product-first Jump To
- \`Visit budget: estimated_screens=… matched_menus=… visit_limit=…\` — dynamic screens

Old-build strings that must be gone:

- \`Found N menu item(s); visiting up to N\`
- \`Menu filter matched 0 of N\`

See \`MANIFEST.md\` for the full file list and dependency expectations.
`,
);

if (wantZip) {
  try {
    execFileSync('zip', ['-qr', `${name}.zip`, name], {
      cwd: path.join(repoRoot, 'deploy', 'worker-apis-upload'),
    });
  } catch {
    console.warn('zip not available — bundle folder created without an archive');
  }
}

const rel = path.relative(repoRoot, bundleRoot);
console.log(`Bundle: ${rel}`);
console.log(`  portals/smoke files: ${srcFiles.length}`);
if (fixtureFiles.length) console.log(`  samples/fixtures files: ${fixtureFiles.length}`);
if (wantZip) console.log(`  archive: ${rel}.zip`);
