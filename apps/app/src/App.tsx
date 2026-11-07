import { useEffect } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import DashboardPage from './pages/Dashboard';
import CardsPage from './pages/Cards';
import CloudPage from './pages/Cloud';
import SettingsPage from './pages/Settings';
import { autoCheckForUpdates, useUpdater } from './data/updater';

const NAV = [
  { to: '/', label: '总览', icon: '◎', end: true },
  { to: '/cards', label: '卡包', icon: '▣', end: false },
  { to: '/cloud', label: '云主机', icon: '☁', end: false },
  { to: '/settings', label: '设置', icon: '⚙', end: false },
];

export default function App() {
  const updateVersion = useUpdater((state) => (state.status === 'available' ? state.available?.version : undefined));

  // 启动 3 秒后静默检查一次更新，失败不打扰用户
  useEffect(() => {
    const timer = setTimeout(() => autoCheckForUpdates(), 3000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">Steward</div>
            <div className="brand-sub">个人数字资产管家</div>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div>本地优先 · 端到端加密</div>
          <div>v0.1.0 MVP</div>
          {updateVersion ? (
            <NavLink to="/settings" style={{ color: 'var(--green)', fontWeight: 600 }}>
              有新版本 v{updateVersion} →
            </NavLink>
          ) : null}
        </div>
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/cards" element={<CardsPage />} />
          <Route path="/cloud" element={<CloudPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<DashboardPage />} />
        </Routes>
      </main>
    </div>
  );
}
