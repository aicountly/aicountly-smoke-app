import { isObserverOnlyEnvironment, isProductionEnvironment } from '@/lib/environments';
import { useProductionContext } from '@/store/productionContext';

export function ProductionBanner() {
  const env = useProductionContext((s) => s.activeEnvironment);
  if (!isProductionEnvironment(env)) {
    return null;
  }
  const observerOnly = isObserverOnlyEnvironment(env);
  return (
    <div className="bg-red-600 text-white px-6 py-2 text-sm font-medium flex items-center justify-center gap-3">
      <span className="inline-block w-2 h-2 rounded-full bg-white/80 animate-pulse" />
      {observerOnly
        ? 'PRODUCTION TARGET ACTIVE — observer mode is enforced; destructive actions are disabled.'
        : 'PRODUCTION TARGET ACTIVE — full access is enabled; approved destructive actions and file uploads can run on live data.'}
    </div>
  );
}
