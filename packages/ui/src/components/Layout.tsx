import { useState } from 'react';
import { Outlet, NavLink } from 'react-router-dom';
import { LayoutDashboard, Boxes, Settings, Layers, Key, BarChart3, Menu, X } from 'lucide-react';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/providers', icon: Boxes, label: 'Providers' },
  { to: '/models', icon: Layers, label: 'Models' },
  { to: '/keys', icon: Key, label: 'API Keys' },
  { to: '/usage', icon: BarChart3, label: 'Usage & Costs' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

export default function Layout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const renderNav = (mobile = false) => (
    <nav className="space-y-1">
      {navItems.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          onClick={() => {
            if (mobile) setMobileNavOpen(false);
          }}
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
              isActive
                ? 'bg-gray-800 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-800'
            }`
          }
        >
          <Icon size={20} />
          {label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="md:hidden sticky top-0 z-40 flex items-center justify-between bg-gray-900 px-4 py-3 text-white">
        <div className="text-lg font-bold">untangle-ai</div>
        <button
          type="button"
          aria-label="Toggle navigation"
          onClick={() => setMobileNavOpen((open) => !open)}
          className="rounded-lg p-2 hover:bg-gray-800"
        >
          {mobileNavOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </header>

      {mobileNavOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
        />
      )}

      <div className="md:flex">
        <aside className="hidden w-64 shrink-0 bg-gray-900 p-4 text-white md:block">
          <div className="text-xl font-bold mb-8 px-2">untangle-ai</div>
          {renderNav()}
        </aside>

        <aside
          className={`fixed inset-y-0 left-0 z-50 w-64 bg-gray-900 p-4 text-white transition-transform md:hidden ${
            mobileNavOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="text-xl font-bold mb-8 px-2">untangle-ai</div>
          {renderNav(true)}
        </aside>

        <main className="min-w-0 flex-1 overflow-x-hidden p-4 sm:p-6 md:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
