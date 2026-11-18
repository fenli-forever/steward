import { useEffect, useLayoutEffect, useRef } from 'react';
import { matchPath, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import DashboardPage from './pages/Dashboard';
import CardsPage from './pages/Cards';
import CloudPage from './pages/Cloud';
import SettingsPage from './pages/Settings';
import { autoCheckForUpdates, useUpdater } from './data/updater';

const NAV = [
  { to: '/', label: '总览', icon: '◎', page: DashboardPage },
  { to: '/cards', label: '卡包', icon: '▣', page: CardsPage },
  { to: '/cloud', label: '云主机', title: '多云主机', icon: '☁', page: CloudPage },
  { to: '/settings', label: '设置', icon: '⚙', page: SettingsPage },
];

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const mainRef = useRef<HTMLElement>(null);
  const current = NAV.find((item) => matchPath(item.to, location.pathname)) ?? NAV[0]!;
  // HashRouter 的 idx 只计算应用路由记录，直接打开子页时回到总览。
  const canGoBack = window.history.state?.idx > 0;
  const updateVersion = useUpdater((state) => (state.status === 'available' ? state.available?.version : undefined));

  useLayoutEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [location.key]);

  // 启动 3 秒后静默检查一次更新，失败不打扰用户
  useEffect(() => {
    const timer = setTimeout(() => autoCheckForUpdates(), 3000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="shell">
      <header className="mobile-header">
        {canGoBack || current.to !== '/' ? (
          <button
            type="button"
            className="btn btn-ghost mobile-back"
            onClick={() => {
              if (canGoBack) navigate(-1);
              else navigate('/', { replace: true });
            }}
          >
            <span aria-hidden="true">‹</span> 返回
          </button>
        ) : null}
        <h1 className="mobile-title">{current.title ?? current.label}</h1>
      </header>

      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">S</div>
          <div>
            <div className="brand-name">Steward</div>
            <div className="brand-sub">个人数字资产管家</div>
          </div>
        </div>

        <nav className="nav" aria-label="主导航">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
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

      <main className="main" ref={mainRef}>
        <Routes>
          {NAV.map(({ to, page: Page }) => <Route key={to} path={to} element={<Page />} />)}
          <Route path="*" element={<DashboardPage />} />
        </Routes>
      </main>
    </div>
  );
}
