import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Routes, Route, useLocation } from 'react-router-dom';
import './styles.css';
import { configureAuth, getUserEmail } from './auth/cognito';
import { LoginGate } from './auth/LoginGate';
import { Layout } from './components/Layout';
import type { Window } from './lib/time-range';
import { OverviewPage } from './pages/OverviewPage';
import { UsagePage } from './pages/UsagePage';
import { CostsPage } from './pages/CostsPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { GovernancePage } from './pages/GovernancePage';
import { AnomaliesPage } from './pages/AnomaliesPage';
import { DoraPage } from './pages/DoraPage';
import { RoiPage } from './pages/RoiPage';
import { LatencyPage } from './pages/LatencyPage';
import { SettingsPage } from './pages/SettingsPage';

configureAuth();

const PAGE_META: Record<string, { title: string; sub: string; windows?: readonly Window[]; fixedCaption?: string }> = {
  '/': { title: 'Overview', sub: 'Spend, budget, anomalies and delivery at a glance — each tile links to its page', windows: [7, 30, 90, 'mtd'] },
  '/usage': { title: 'Token Usage', sub: 'Consumption across models and time', windows: [7, 30, 90, 'mtd'] },
  '/costs': { title: 'Estimated Cost', sub: 'Spend by model, derived from token usage', windows: [7, 30, 90, 'mtd'] },
  '/projects': { title: 'Usage by Project', sub: 'Attribution via inference profiles, request metadata and the project registry', windows: [], fixedCaption: 'All time · rollups' },
  '/governance': { title: 'Cost Governance', sub: 'Budget status and enforcement guardrails', windows: [], fixedCaption: 'Month to date · AWS Budgets period' },
  '/anomalies': { title: 'Anomalies & Alerts', sub: 'Automated detection and response feed', windows: [7, 30, 90, 'mtd'] },
  '/dora': { title: 'DORA Metrics', sub: 'Delivery performance per repo — humans + AI coding assistants', windows: [7, 30, 90] },
  '/roi': { title: 'AI ROI', sub: 'Break-even first — DORA ROI model over measured cost and delivery, disclosed assumptions, honest brackets', windows: [30, 90] },
  // No `windows` key: the page owns its own picker, because the latency windows are 1/7/30 rather
  // than the shell's 7/30/90/mtd, and it pairs them with a percentile control in the same toolbar.
  '/settings': { title: 'Settings', sub: 'Project registry and DORA repositories — admin group only' },
  '/latency': { title: 'Model-hop Latency', sub: 'Bedrock service time across the end-to-end chain — measured hops only, fleet-wide' },
};

function Shell({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<string | null>(null);
  useEffect(() => { getUserEmail().then(setUser); }, []);
  const { pathname } = useLocation();
  const meta = PAGE_META[pathname] ?? PAGE_META['/'];
  return <Layout title={meta.title} subtitle={meta.sub} user={user} windows={meta.windows} fixedCaption={meta.fixedCaption}>{children}</Layout>;
}

function App() {
  return (
    <LoginGate>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Shell><OverviewPage /></Shell>} />
          <Route path="/usage" element={<Shell><UsagePage /></Shell>} />
          <Route path="/costs" element={<Shell><CostsPage /></Shell>} />
          <Route path="/projects" element={<Shell><ProjectsPage /></Shell>} />
          <Route path="/governance" element={<Shell><GovernancePage /></Shell>} />
          <Route path="/anomalies" element={<Shell><AnomaliesPage /></Shell>} />
          <Route path="/dora" element={<Shell><DoraPage /></Shell>} />
          <Route path="/roi" element={<Shell><RoiPage /></Shell>} />
          <Route path="/latency" element={<Shell><LatencyPage /></Shell>} />
          <Route path="/settings" element={<Shell><SettingsPage /></Shell>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </LoginGate>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
