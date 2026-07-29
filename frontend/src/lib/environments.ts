/** Target environment safety tiers, mirroring backend Config\Environments. */
export const ENVIRONMENTS = [
  { v: 'sandbox', label: 'Sandbox', shortLabel: 'Sandbox' },
  { v: 'gh_staging', label: 'GH / Staging', shortLabel: 'GH / Staging' },
  { v: 'production_readonly', label: 'Production Read-Only', shortLabel: 'Production R/O' },
  { v: 'production_restricted', label: 'Production Restricted', shortLabel: 'Production Restricted' },
  { v: 'production_full_access', label: 'Production Full Access', shortLabel: 'Production Full' },
] as const;

const PRODUCTION = ['production_readonly', 'production_restricted', 'production_full_access'];

const OBSERVER_ONLY = ['production_readonly', 'production_restricted'];

/** Live targets, for the banner and the red badge. */
export function isProductionEnvironment(environment: string | null | undefined): boolean {
  return !!environment && PRODUCTION.includes(environment.trim().toLowerCase());
}

/** Live targets where destructive actions are always disabled. */
export function isObserverOnlyEnvironment(environment: string | null | undefined): boolean {
  return !!environment && OBSERVER_ONLY.includes(environment.trim().toLowerCase());
}

export function environmentLabel(environment: string): string {
  return ENVIRONMENTS.find((e) => e.v === environment)?.label ?? environment;
}
