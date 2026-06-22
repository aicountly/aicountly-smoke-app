/** AICOUNTLY SaaS products (my.aicountly.com suite). Legacy slugs excluded. */
export const SAAS_PRODUCTS = [
  { slug: 'contacts', label: 'Contacts' },
  { slug: 'my-account', label: 'My Account' },
  { slug: 'books', label: 'Smart Books' },
  { slug: 'calendar', label: 'Calendar' },
  { slug: 'docs', label: 'Docs' },
  { slug: 'chat', label: 'Chat' },
  { slug: 'auditor', label: 'Auditor' },
  { slug: 'fr', label: 'Financial Reporting' },
  { slug: 'secretarial', label: 'Secretarial' },
  { slug: 'vault', label: 'Vault' },
  { slug: 'hrms', label: 'HRMS' },
] as const;

export type SaasProductSlug = (typeof SAAS_PRODUCTS)[number]['slug'];

export type SaasProductOption = { slug: string; label: string };

export const SAAS_PRODUCT_SLUGS: SaasProductSlug[] = SAAS_PRODUCTS.map((p) => p.slug);

export function saasProductLabel(slug: string): string {
  return SAAS_PRODUCTS.find((p) => p.slug === slug)?.label ?? slug;
}
