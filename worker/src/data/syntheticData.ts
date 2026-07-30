import { invokeBrain } from '../brain/ensemble.js';
import type { MarkDescriptor } from '../agent/marks.js';
import { isUnsafeToFill } from '../forms/fieldSynthesis.js';
import type { FileIoScenario } from '../fileIo/types.js';

export type SyntheticDataset = {
  columns: string[];
  rows: string[][];
  notes?: string;
};

export type SyntheticDataResult = {
  fields: Record<string, string>;
  dataset?: SyntheticDataset;
  provider: string;
};

const FORM_SYSTEM = `You generate realistic synthetic QA data for smoke tests of business SaaS apps.
Prefer industry-standard field values for HRMS/accounting/ERP forms.
Every free-TEXT value MUST begin with the marker "SMOKE-" (emails may use a smoke. local-part).
Values a validator reads as a number are given bare, with no marker: phone/mobile/WhatsApp
numbers, amounts, quantities, PIN codes, dates (dd/mm/yyyy) and times.
Never invent statutory IDs (GSTIN, PAN, Aadhaar, bank account, IFSC, CIN) — leave those fields out.
Return JSON only: {"fields":{"Field Label":"SMOKE-value"},"notes":""}`;

const DATASET_SYSTEM = `You design synthetic CSV/tabular datasets for smoke-test file uploads.
Use industry-standard columns for the product and scenario.
Every free-text cell MUST begin with "SMOKE-" (emails may use smoke. local-part).
Return 3-8 data rows. Return JSON only:
{"dataset":{"columns":["Col A","Col B"],"rows":[["SMOKE-a","1"],["SMOKE-b","2"]]},"notes":""}`;

export async function requestFormValues(input: {
  marks: MarkDescriptor[];
  product: string;
  environment: string;
  sessionName: string;
  url: string;
}): Promise<SyntheticDataResult> {
  const fillable = input.marks.filter((mark) => isFillable(mark));
  if (fillable.length === 0) {
    return { fields: {}, provider: 'none' };
  }
  const response = await invokeBrain(
    'synthetic_data',
    FORM_SYSTEM,
    JSON.stringify({
      product: input.product,
      environment: input.environment,
      session: input.sessionName,
      url: input.url,
      fields: fillable.map((mark) => ({
        mark: mark.mark,
        name: mark.name,
        tag: mark.tag,
        type: mark.type,
        value: mark.value,
      })),
    }),
    {
      expect_json: true,
      product: input.product,
      environment: input.environment,
    },
  );
  return {
    fields: readFields(response.final),
    dataset: readDataset(response.final),
    provider: String(response.arbiter ?? 'unknown'),
  };
}

export async function requestDataset(input: {
  scenario: FileIoScenario;
  product: string;
  environment: string;
}): Promise<SyntheticDataResult> {
  const response = await invokeBrain(
    'synthetic_data',
    DATASET_SYSTEM,
    JSON.stringify({
      product: input.product,
      environment: input.environment,
      scenario: {
        key: input.scenario.key,
        kind: input.scenario.kind,
        fixture: input.scenario.fixture,
        expected_mime: input.scenario.expected_mime,
        competitor_standard: input.scenario.competitor_standard_prompt,
      },
    }),
    {
      expect_json: true,
      product: input.product,
      environment: input.environment,
    },
  );
  return {
    fields: readFields(response.final),
    dataset: readDataset(response.final),
    provider: String(response.arbiter ?? 'unknown'),
  };
}

function isFillable(mark: MarkDescriptor): boolean {
  if (mark.disabled) return false;
  const tag = mark.tag.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false;
  const type = mark.type.toLowerCase();
  if (['hidden', 'password', 'file', 'submit', 'button', 'checkbox', 'radio', 'image'].includes(type)) {
    return false;
  }
  if (String(mark.value || '').trim()) return false;
  if (isUnsafeToFill({
    tag: tag as 'input' | 'select' | 'textarea',
    type: mark.type,
    name: mark.name,
    id: '',
    placeholder: '',
    ariaLabel: mark.name,
    label: mark.name,
    required: false,
  })) {
    return false;
  }
  return true;
}

function readFields(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  const source = (row.fields && typeof row.fields === 'object' && !Array.isArray(row.fields))
    ? row.fields as Record<string, unknown>
    : row;
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    if (key === 'dataset' || key === 'notes' || key === 'fields') continue;
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      out[key] = String(item);
    }
  }
  return out;
}

function readDataset(value: unknown): SyntheticDataset | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const dataset = (row.dataset && typeof row.dataset === 'object' && !Array.isArray(row.dataset))
    ? row.dataset as Record<string, unknown>
    : row;
  const columns = Array.isArray(dataset.columns) ? dataset.columns.map(String) : [];
  const rows = Array.isArray(dataset.rows)
    ? dataset.rows
      .filter((item): item is unknown[] => Array.isArray(item))
      .map((item) => item.map((cell) => String(cell ?? '')))
    : [];
  if (columns.length === 0 || rows.length === 0) return undefined;
  return {
    columns,
    rows,
    notes: typeof dataset.notes === 'string' ? dataset.notes
      : typeof row.notes === 'string' ? row.notes : undefined,
  };
}
