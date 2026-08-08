import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Home from './pages/Home';
import Graph from './pages/Graph';
import Analytics from './pages/Analytics';
import Watchlist from './pages/Watchlist';
import Settings from './pages/Settings';
import './App.css';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="graph" element={<Graph />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="watchlist" element={<Watchlist />} />
          <Route path="settings" element={<Settings />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
