import { useProductionContext } from '@/store/productionContext';

export function ProductionBanner() {
  const env = useProductionContext((s) => s.activeEnvironment);
  if (env !== 'production_readonly' && env !== 'production_restricted') {
    return null;
  }
  return (
    <div className="bg-red-600 text-white px-6 py-2 text-sm font-medium flex items-center justify-center gap-3">
      <span className="inline-block w-2 h-2 rounded-full bg-white/80 animate-pulse" />
      PRODUCTION TARGET ACTIVE &mdash; observer mode is enforced; destructive actions are disabled.
    </div>
  );
}
