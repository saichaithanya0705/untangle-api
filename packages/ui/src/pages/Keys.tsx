import { useEffect, useState } from 'react';
import { Key, CheckCircle, XCircle, AlertCircle, Plus, Trash2, TestTube, Loader2, X, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';

interface ProviderKey {
  id: string;
  name: string;
  envVar: string;
  hasKey: boolean;
}

export default function Keys() {
  const [providers, setProviders] = useState<ProviderKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ provider: string; success: boolean; message: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState<string | null>(null);

  const fetchKeys = async () => {
    try {
      const res = await fetch('/api/keys');
      if (!res.ok) throw new Error('Failed to fetch keys');
      const data = await res.json();
      setProviders(data.providers);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load keys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKeys();
  }, []);

  const handleAddKey = async () => {
    if (!selectedProvider || !apiKeyInput.trim()) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/keys/${selectedProvider}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKeyInput }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message || 'Failed to save key');
      }

      // Automatically discover models for this provider
      setDiscovering(selectedProvider);
      try {
        const result = await api.discoverModels(selectedProvider);
        if (result.models.length > 0) {
          // Add the discovered models to the registry
          await api.addModels(selectedProvider, result.models);
          setTestResult({
            provider: selectedProvider,
            success: true,
            message: `Key saved! Discovered ${result.models.length} models from ${selectedProvider}`,
          });
        } else {
          setTestResult({
            provider: selectedProvider,
            success: true,
            message: `Key saved for ${selectedProvider}`,
          });
        }
      } catch {
        // Discovery failed, but key was saved
        setTestResult({
          provider: selectedProvider,
          success: true,
          message: `Key saved for ${selectedProvider}. Model discovery unavailable.`,
        });
      } finally {
        setDiscovering(null);
      }

      setShowAddModal(false);
      setSelectedProvider(null);
      setApiKeyInput('');
      await fetchKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save key');
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveKey = async (providerId: string) => {
    try {
      const res = await fetch(`/api/keys/${providerId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error?.message || 'Failed to remove key');
      }

      setConfirmDelete(null);
      await fetchKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove key');
    }
  };

  const handleTestKey = async (providerId: string) => {
    setTesting(providerId);
    setTestResult(null);

    try {
      const res = await fetch(`/api/keys/${providerId}/test`, {
        method: 'POST',
      });

      const data = await res.json();

      setTestResult({
        provider: providerId,
        success: data.success,
        message: data.success ? data.message : data.error?.message || 'Test failed',
      });
    } catch (err) {
      setTestResult({
        provider: providerId,
        success: false,
        message: err instanceof Error ? err.message : 'Test failed',
      });
    } finally {
      setTesting(null);
    }
  };

  const openAddModal = (providerId: string) => {
    setSelectedProvider(providerId);
    setApiKeyInput('');
    setShowAddModal(true);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="animate-spin text-gray-400" size={32} />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">API Keys</h1>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <div className="flex items-start gap-3">
            <XCircle className="text-red-600 mt-0.5" size={20} />
            <div>
              <p className="text-sm text-red-700">{error}</p>
              <button
                onClick={() => setError(null)}
                className="text-sm text-red-600 underline mt-1"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6">
        <div className="flex items-start gap-3">
          <AlertCircle className="text-yellow-600 mt-0.5" size={20} />
          <div>
            <h3 className="font-medium text-yellow-800">API Key Management</h3>
            <p className="text-sm text-yellow-700 mt-1">
              Keys can be configured via environment variables or added here for runtime use.
              Runtime keys are stored in memory and will be lost when the server restarts.
            </p>
          </div>
        </div>
      </div>

      {testResult && (
        <div
          className={`border rounded-lg p-4 mb-6 ${
            testResult.success
              ? 'bg-green-50 border-green-200'
              : 'bg-red-50 border-red-200'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {testResult.success ? (
                <CheckCircle className="text-green-600" size={20} />
              ) : (
                <XCircle className="text-red-600" size={20} />
              )}
              <span
                className={testResult.success ? 'text-green-700' : 'text-red-700'}
              >
                {testResult.message}
              </span>
            </div>
            <button
              onClick={() => setTestResult(null)}
              className="text-gray-400 hover:text-gray-600"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Provider
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Environment Variable
              </th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                Status
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {providers.map((provider) => (
              <tr key={provider.id}>
                <td className="px-6 py-4">
                  <div className="flex items-center gap-2">
                    <Key className="text-gray-400" size={16} />
                    <span className="font-medium">{provider.name}</span>
                  </div>
                </td>
                <td className="px-6 py-4">
                  <code className="text-sm bg-gray-100 px-2 py-1 rounded">
                    {provider.envVar}
                  </code>
                </td>
                <td className="px-6 py-4">
                  {provider.hasKey ? (
                    <div className="flex items-center gap-2 text-green-600">
                      <CheckCircle size={16} />
                      <span>Configured</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-gray-400">
                      <XCircle size={16} />
                      <span>Not set</span>
                    </div>
                  )}
                </td>
                <td className="px-6 py-4">
                  <div className="flex items-center justify-end gap-2">
                    {provider.hasKey ? (
                      <>
                        <button
                          onClick={() => handleTestKey(provider.id)}
                          disabled={testing === provider.id}
                          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-50 text-blue-600 rounded hover:bg-blue-100 disabled:opacity-50"
                        >
                          {testing === provider.id ? (
                            <Loader2 className="animate-spin" size={14} />
                          ) : (
                            <TestTube size={14} />
                          )}
                          Test
                        </button>
                        <button
                          onClick={() => setConfirmDelete(provider.id)}
                          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-red-50 text-red-600 rounded hover:bg-red-100"
                        >
                          <Trash2 size={14} />
                          Remove
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => openAddModal(provider.id)}
                        className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-50 text-green-600 rounded hover:bg-green-100"
                      >
                        <Plus size={14} />
                        Add Key
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6 p-4 bg-gray-50 rounded-lg">
        <h3 className="font-medium mb-2">Setting keys via environment variables</h3>
        <div className="text-sm text-gray-600 space-y-2">
          <p>For persistent configuration, set environment variables before starting:</p>
          <pre className="bg-gray-800 text-gray-100 p-3 rounded text-xs overflow-x-auto">
{`# Linux/macOS
export OPENAI_API_KEY=sk-your-key
export ANTHROPIC_API_KEY=sk-ant-your-key

# Windows (PowerShell)
$env:OPENAI_API_KEY="sk-your-key"
$env:ANTHROPIC_API_KEY="sk-ant-your-key"

# Then start the server
untangle-ai start`}
          </pre>
        </div>
      </div>

      {/* Add Key Modal */}
      {showAddModal && selectedProvider && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">
                Add API Key for {providers.find((p) => p.id === selectedProvider)?.name}
              </h2>
              <button
                onClick={() => setShowAddModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X size={20} />
              </button>
            </div>

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                API Key
              </label>
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="sk-..."
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <p className="text-xs text-gray-500 mt-1">
                The key will be stored in memory for this session only.
                Models will be automatically discovered from the provider.
              </p>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowAddModal(false)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
                disabled={saving || discovering === selectedProvider}
              >
                Cancel
              </button>
              <button
                onClick={handleAddKey}
                disabled={saving || discovering === selectedProvider || !apiKeyInput.trim()}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
              >
                {(saving || discovering === selectedProvider) && <Loader2 className="animate-spin" size={14} />}
                {discovering === selectedProvider ? 'Discovering Models...' : saving ? 'Saving...' : 'Save & Discover Models'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-md">
            <h2 className="text-lg font-semibold mb-2">Confirm Removal</h2>
            <p className="text-gray-600 mb-4">
              Are you sure you want to remove the API key for{' '}
              <strong>{providers.find((p) => p.id === confirmDelete)?.name}</strong>?
            </p>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRemoveKey(confirmDelete)}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                Remove Key
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
