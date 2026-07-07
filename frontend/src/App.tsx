import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { useAuthBootstrap } from '@/hooks/useAuthBootstrap';
import { ControllerGate } from '@/pages/ControllerGate';
import { DashboardPage } from '@/pages/DashboardPage';
import { TargetProfilesPage } from '@/pages/TargetProfilesPage';
import { NewObservationPage } from '@/pages/NewObservationPage';
import { SessionPlanPage } from '@/pages/SessionPlanPage';
import { RunsPage } from '@/pages/RunsPage';
import { RunDetailPage } from '@/pages/RunDetailPage';
import { ReportsPage } from '@/pages/ReportsPage';
import { FeatureGapMatrixPage } from '@/pages/FeatureGapMatrixPage';
import { CompetitorBenchmarksPage } from '@/pages/CompetitorBenchmarksPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { AuditLogsPage } from '@/pages/AuditLogsPage';
import { useAuthStore } from '@/store/auth';

export default function App() {
  const accessToken = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const { loading, ssoPending, gateReason, gateMessage, retryAuth } = useAuthBootstrap();

  if (loading || ssoPending) {
    return (
      <div className="grid h-screen place-items-center text-sm text-ink-500">
        {ssoPending ? 'Signing you in from Console…' : 'Loading Smoke Portal…'}
      </div>
    );
  }

  if (!accessToken || !user) {
    return (
      <ControllerGate
        gateReason={gateReason}
        gateMessage={gateMessage}
        retryAuth={retryAuth}
        ssoPending={ssoPending}
      />
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to="/" replace />} />

      <Route path="/" element={<AppShell />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="profiles" element={<TargetProfilesPage />} />
        <Route path="observations/new" element={<NewObservationPage />} />
        <Route path="session-plans/:id" element={<SessionPlanPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:id" element={<RunDetailPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="feature-gap-matrix" element={<FeatureGapMatrixPage />} />
        <Route path="competitor-benchmarks" element={<CompetitorBenchmarksPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="audit-logs" element={<AuditLogsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
