import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { RequireAuth } from '@/components/auth/RequireAuth';
import { LoginPage } from '@/pages/LoginPage';
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

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
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
