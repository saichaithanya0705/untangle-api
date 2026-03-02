import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { api, getStoredAdminKey, setStoredAdminKey, type ServerSettings } from '@/lib/api';

export default function Settings() {
  const [settings, setSettings] = useState<ServerSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adminKey, setAdminKey] = useState(getStoredAdminKey());
  const [adminKeyStatus, setAdminKeyStatus] = useState<string | null>(null);

  useEffect(() => {
    void loadSettings();
  }, []);

  async function loadSettings() {
    setLoading(true);
    try {
      const data = await api.getSettings();
      setSettings(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveAdminKey() {
    setStoredAdminKey(adminKey.trim());
    setAdminKeyStatus(adminKey.trim() ? 'Admin key saved.' : 'Admin key cleared.');
    await loadSettings();
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Settings</h1>
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Server Configuration</CardTitle>
          <CardDescription>
            These values reflect the currently running server process.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="admin-key">Admin API Key</Label>
            <div className="flex flex-col gap-3 max-w-xl">
              <Input
                id="admin-key"
                type="password"
                value={adminKey}
                onChange={(event) => setAdminKey(event.target.value)}
                placeholder="Enter admin key to access /api endpoints"
              />
              <div className="flex items-center gap-3">
                <Button type="button" onClick={handleSaveAdminKey} variant="secondary" size="sm">
                  Save Admin Key
                </Button>
                {adminKeyStatus && (
                  <span className="text-sm text-gray-500">{adminKeyStatus}</span>
                )}
              </div>
              <p className="text-xs text-gray-500">
                Stored locally in this browser session to authorize admin UI calls.
              </p>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="port">Port</Label>
            <Input
              id="port"
              type="number"
              value={loading ? '' : (settings?.server.port ?? '')}
              disabled
              className="max-w-xs"
              readOnly
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="host">Host</Label>
            <Input
              id="host"
              type="text"
              value={loading ? '' : (settings?.server.host ?? '')}
              disabled
              className="max-w-xs"
              readOnly
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="log-level">Log Level</Label>
            <Input
              id="log-level"
              type="text"
              value={loading ? '' : (settings?.observability?.level ?? '')}
              disabled
              className="max-w-xs"
              readOnly
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="tracing-enabled">Tracing Enabled</Label>
            <Input
              id="tracing-enabled"
              type="text"
              value={loading ? '' : (settings?.observability?.tracingEnabled ? 'true' : 'false')}
              disabled
              className="max-w-xs"
              readOnly
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
