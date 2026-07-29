export type FileIoKind = 'upload' | 'import' | 'export' | 'round_trip';
export type CompareStatus = 'pass' | 'fail' | 'partial' | 'not_applicable' | 'skipped' | 'blocked';

export type FileIoExecutionContext = {
  urls: string[];
  titles: string[];
  inventoryLabels: string[];
};

export type FileIoScenario = {
  key: string;
  kind: FileIoKind;
  fixture: string;
  expected_mime: string[];
  menu_hints: string[];
  competitor_standard_prompt: string;
};

export type FixtureManifest = {
  version: number;
  products: Record<string, FileIoScenario[]>;
};

export type MaterializedFixture = {
  scenario: FileIoScenario;
  sourcePath: string;
  runPath: string;
  name: string;
};

export type ArtifactComparison = {
  status: CompareStatus;
  source_sha256?: string;
  result_sha256: string;
  source_mime?: string;
  result_mime: string;
  source_bytes?: number;
  result_bytes: number;
  structure_ok: boolean;
  structure_notes: string;
};

export type FileQualityResult = {
  scores: { formatting: number; completeness: number; alignment: number; export_quality: number; overall: number };
  verdict: string;
  gaps: string[];
  recommendations: string[];
  competitor_refs: string[];
};

export type FileIoTestResult = Partial<ArtifactComparison> & {
  scenario_key: string;
  direction: 'upload' | 'download' | 'round_trip';
  fixture_name: string;
  upload_ok: boolean;
  download_ok: boolean;
  compare_status: CompareStatus;
  ai_scores?: FileQualityResult['scores'];
  ai_verdict?: string;
  ai_recommendations?: string[];
  competitor_refs?: string[];
  artifact_paths: Record<string, string>;
  evidence: Record<string, unknown>;
};
