import fs from 'node:fs';
import { invokeBrain } from '../brain/ensemble.js';
import type { ArtifactComparison, FileIoScenario, FileQualityResult } from './types.js';

export async function reviewFileQuality(input: {
  product: string;
  environment: string;
  scenario: FileIoScenario;
  artifactPath: string;
  comparison: ArtifactComparison;
}): Promise<FileQualityResult> {
  const excerpt = extractExcerpt(input.artifactPath);
  const result = await invokeBrain(
    'file_quality',
    `Review exported or round-tripped files against professional SaaS standards. Use only supplied evidence.
Return JSON: {"scores":{"formatting":0,"completeness":0,"alignment":0,"export_quality":0,"overall":0},"verdict":"","gaps":[],"recommendations":[],"competitor_refs":[]}.`,
    JSON.stringify({
      product: input.product,
      scenario: input.scenario.key,
      competitor_standard: input.scenario.competitor_standard_prompt,
      comparison: input.comparison,
      excerpt,
    }),
    {
      expect_json: true,
      product: input.product,
      environment: input.environment,
      fidelity: input.comparison,
    },
  );
  return normalizeQuality(result.final, input.comparison);
}

function extractExcerpt(filePath: string): string {
  const content = fs.readFileSync(filePath).subarray(0, 16 * 1024);
  return Array.from(content.toString('utf8'), (character) => {
    const code = character.charCodeAt(0);
    return character === '\n' || character === '\r' || character === '\t' || (code >= 32 && code <= 126)
      ? character
      : ' ';
  }).join('').slice(0, 16 * 1024);
}

export function normalizeQuality(value: unknown, comparison: ArtifactComparison): FileQualityResult {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rawScores = record.scores && typeof record.scores === 'object'
    ? record.scores as Record<string, unknown>
    : {};
  const fallback = comparison.status === 'pass' ? 100 : comparison.status === 'partial' ? 70 : 25;
  const score = (key: string) => clamp(Number(rawScores[key] ?? fallback));
  return {
    scores: {
      formatting: score('formatting'),
      completeness: score('completeness'),
      alignment: score('alignment'),
      export_quality: score('export_quality'),
      overall: score('overall'),
    },
    verdict: String(record.verdict ?? `Deterministic fidelity verdict: ${comparison.status}.`),
    gaps: strings(record.gaps),
    recommendations: strings(record.recommendations),
    competitor_refs: strings(record.competitor_refs),
  };
}

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}
