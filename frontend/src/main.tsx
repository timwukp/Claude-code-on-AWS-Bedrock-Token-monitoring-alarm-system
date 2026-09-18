import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Routes, Route, useLocation } from 'react-router-dom';
import './styles.css';
import { configureAuth, getUserEmail } from './auth/cognito';
import { LoginGate } from './auth/LoginGate';
import { Layout } from './components/Layout';
import { UsagePage } from './pages/UsagePage';
import { CostsPage } from './pages/CostsPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { GovernancePage } from './pages/GovernancePage';
import { AnomaliesPage } from './pages/AnomaliesPage';
import { DoraPage } from './pages/DoraPage';
import { RoiPage } from './pages/RoiPage';

configureAuth();

const PAGE_META: Record<string, { title: string; sub: string }> = {
  '/': { title: 'Token Usage', sub: 'Real-time consumption across models and time' },
  '/costs': { title: 'Estimated Cost', sub: 'Spend by model, derived from token usage' },
  '/projects': { title: 'Usage by Project', sub: 'Attribution via inference profiles, request metadata and the project registry' },
  '/governance': { title: 'Cost Governance', sub: 'Budget status and enforcement guardrails' },
  '/anomalies': { title: 'Anomalies & Alerts', sub: 'Automated detection and response feed' },
  '/dora': { title: 'DORA Metrics', sub: 'Delivery performance per repo — humans + AI coding assistants' },
  '/roi': { title: 'AI ROI', sub: 'Break-even first — DORA ROI model over measured cost and delivery, disclosed assumptions, honest brackets' },
};

function Shell({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<string | null>(null);
  useEffect(() => { getUserEmail().then(setUser); }, []);
  const { pathname } = useLocation();
  const meta = PAGE_META[pathname === '/usage' ? '/' : pathname] ?? PAGE_META['/'];
  return <Layout title={meta.title} subtitle={meta.sub} user={user}>{children}</Layout>;
}

function App() {
  return (
    <LoginGate>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Shell><UsagePage /></Shell>} />
          <Route path="/usage" element={<Shell><UsagePage /></Shell>} />
          <Route path="/costs" element={<Shell><CostsPage /></Shell>} />
          <Route path="/projects" element={<Shell><ProjectsPage /></Shell>} />
          <Route path="/governance" element={<Shell><GovernancePage /></Shell>} />
          <Route path="/anomalies" element={<Shell><AnomaliesPage /></Shell>} />
          <Route path="/dora" element={<Shell><DoraPage /></Shell>} />
          <Route path="/roi" element={<Shell><RoiPage /></Shell>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </LoginGate>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
