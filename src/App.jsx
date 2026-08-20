import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import Portfolio from './pages/Portfolio';
import Graph from './pages/Graph';
import Analytics from './pages/Analytics';
import Watchlist from './pages/Watchlist';
import Settings from './pages/Settings';
import Transactions from './pages/Transactions';
import SecuritySettings from './pages/SecuritySettings';
import PortfoliosSettings from './pages/PortfoliosSettings';
import IbkrImport from './pages/IbkrImport';
import CsvImport from './pages/CsvImport';
import KtradeImport from './pages/KtradeImport';
import Login from './pages/Login';
import NetworkSettings from './pages/NetworkSettings';
import ProtectedRoute from './components/ProtectedRoute';
import './App.css';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }>
          <Route index element={<Home />} />
          <Route path="portfolio" element={<Portfolio />} />
          <Route path="graph" element={<Graph />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="watchlist" element={<Watchlist />} />
          <Route path="transactions" element={<Transactions />} />
          <Route path="settings" element={<Settings />} />
          <Route path="settings/import" element={<IbkrImport />} />
          <Route path="settings/import/ibkr" element={<IbkrImport />} />
          <Route path="settings/import/csv" element={<CsvImport />} />
          {/* Old path kept so existing links/bookmarks still resolve. */}
          <Route path="settings/import/budget" element={<CsvImport />} />
          <Route path="settings/import/ktrade" element={<KtradeImport />} />
          <Route path="settings/security" element={<SecuritySettings />} />
          <Route path="settings/portfolios" element={<PortfoliosSettings />} />
          <Route path="settings/network" element={<NetworkSettings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
