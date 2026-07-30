import fs from 'node:fs';
import path from 'node:path';
import type { SyntheticDataset } from '../data/syntheticData.js';
import { isRenderableExtension, renderFixture } from './renderFixture.js';
import type { FileIoScenario, FixtureManifest, MaterializedFixture } from './types.js';

export function loadFixtureManifest(repoRoot: string): FixtureManifest {
  const manifestPath = path.join(repoRoot, 'samples', 'fixtures', 'manifest.json');
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as FixtureManifest;
  if (!parsed.products || typeof parsed.products !== 'object') throw new Error('Fixture manifest has no products map.');
  return parsed;
}

export function scenariosForProduct(repoRoot: string, product: string): FileIoScenario[] {
  return loadFixtureManifest(repoRoot).products[product.toLowerCase()] ?? [];
}

export function materializeFixture(
  repoRoot: string,
  reportsDir: string,
  scenario: FileIoScenario,
  dataset?: SyntheticDataset,
): MaterializedFixture {
  const fixtureRoot = path.resolve(repoRoot, 'samples', 'fixtures');
  const sourcePath = path.resolve(fixtureRoot, scenario.fixture);
  if (sourcePath !== fixtureRoot && !sourcePath.startsWith(`${fixtureRoot}${path.sep}`)) {
    throw new Error(`Fixture path escapes samples/fixtures: ${scenario.fixture}`);
  }
  if (!fs.statSync(sourcePath).isFile()) throw new Error(`Fixture is not a file: ${scenario.fixture}`);

  const targetDir = path.join(reportsDir, 'fixtures', safeSegment(scenario.key));
  fs.mkdirSync(targetDir, { recursive: true });
  const runPath = path.join(targetDir, path.basename(sourcePath));

  if (dataset && isRenderableExtension(runPath)) {
    const rendered = renderFixture(runPath, dataset);
    if (rendered.ok) {
      return { scenario, sourcePath, runPath, name: path.basename(runPath) };
    }
  }

  fs.copyFileSync(sourcePath, runPath);
  return { scenario, sourcePath, runPath, name: path.basename(runPath) };
}

function safeSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'fixture';
}
