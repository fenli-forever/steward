import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 不存在');

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    {/* HashRouter：Tauri 的 WebView 与 file:// 预览下都不需要服务端路由重写 */}
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
