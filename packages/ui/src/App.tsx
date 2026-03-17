import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Providers from './pages/Providers';
import Models from './pages/Models';
import Keys from './pages/Keys';
import Usage from './pages/Usage';
import Settings from './pages/Settings';
import SharedDashboard from './pages/SharedDashboard';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="providers" element={<Providers />} />
        <Route path="models" element={<Models />} />
        <Route path="keys" element={<Keys />} />
        <Route path="usage" element={<Usage />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="/shared/dashboard/:token" element={<SharedDashboard />} />
    </Routes>
  );
}
