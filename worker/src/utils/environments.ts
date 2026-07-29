/**
 * Target environment safety tiers, mirroring backend Config\Environments.
 *
 * Never gate behaviour on environment.startsWith('production') — that sweeps
 * production_full_access into the observer-only rules it is meant to opt out of.
 */

export const ENVIRONMENTS = {
  sandbox: 'sandbox',
  ghStaging: 'gh_staging',
  productionReadonly: 'production_readonly',
  productionRestricted: 'production_restricted',
  productionFullAccess: 'production_full_access',
} as const;

/** Live targets that may never click a restricted label or touch files. */
const OBSERVER_ONLY: string[] = [
  ENVIRONMENTS.productionReadonly,
  ENVIRONMENTS.productionRestricted,
];

/** Tiers where destructive actions and file mutations may be opted into. */
const FULL_ACCESS: string[] = [
  ENVIRONMENTS.sandbox,
  ENVIRONMENTS.ghStaging,
  ENVIRONMENTS.productionFullAccess,
];

function normalize(environment: string): string {
  return environment.trim().toLowerCase();
}

export function isObserverOnlyEnvironment(environment: string): boolean {
  return OBSERVER_ONLY.includes(normalize(environment));
}

export function allowsFullAccess(environment: string): boolean {
  return FULL_ACCESS.includes(normalize(environment));
}
