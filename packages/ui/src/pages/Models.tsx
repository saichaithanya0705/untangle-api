import { useEffect, useState } from 'react';
import { RefreshCw, Info } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ModelTable } from '@/components/ModelTable';
import { api, FullModel } from '@/lib/api';

export default function Models() {
  const [models, setModels] = useState<FullModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const providerMeta = Array.from(
    models.reduce((acc, model) => {
      const existing = acc.get(model.providerId);
      if (!existing) {
        acc.set(model.providerId, {
          id: model.providerId,
          name: model.providerName,
          enabled: model.providerEnabled ?? true,
        });
        return acc;
      }
      if (model.providerEnabled === false) {
        existing.enabled = false;
      }
      return acc;
    }, new Map<string, { id: string; name: string; enabled: boolean }>())
      .values()
  );

  const loadModels = async () => {
    setLoading(true);
    try {
      const data = await api.getFullModels();
      setModels(data);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to load models');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModels();
  }, []);

  const handleToggle = async (model: FullModel, enabled: boolean) => {
    try {
      setError(null);
      setNotice(null);
      await api.toggleModel(model.providerId, model.id, enabled);
      setModels((prev) =>
        prev.map((m) =>
          m.id === model.id && m.providerId === model.providerId
            ? { ...m, enabled }
            : m
        )
      );
      setNotice(`${enabled ? 'Enabled' : 'Disabled'} ${model.id}.`);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to toggle model');
    }
  };

  const handleRefreshPricing = async () => {
    setRefreshing(true);
    try {
      setError(null);
      setNotice(null);
      await api.refreshOpenRouterModels();
      await api.refreshPricing();
      await loadModels();
      setNotice('Pricing and model metadata refreshed.');
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to refresh pricing');
    } finally {
      setRefreshing(false);
    }
  };

  const filteredModels = selectedProvider
    ? models.filter((m) => m.providerId === selectedProvider)
    : models;

  const enabledCount = filteredModels.filter(
    (m) => m.enabled && (m.providerEnabled ?? true)
  ).length;
  const selectedProviderMeta = providerMeta.find((provider) => provider.id === selectedProvider);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Models</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefreshPricing}
            disabled={refreshing}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh Pricing
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {notice && (
        <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {notice}
        </div>
      )}

      {/* Info about auto-discovery */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <div className="flex items-start gap-3">
          <Info className="text-blue-600 mt-0.5" size={20} />
          <div>
            <h3 className="font-medium text-blue-800">Automatic Model Discovery</h3>
            <p className="text-sm text-blue-700 mt-1">
              Models are automatically discovered when you add an API key for a provider.
              Cost source order is: OpenRouter catalog first, then provider API/docs, then web-search fallback.
              If no source resolves, pricing remains unknown and is shown as &ldquo;-&rdquo;.
            </p>
          </div>
        </div>
      </div>

      {/* Provider Filter */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <Button
          variant={selectedProvider === '' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setSelectedProvider('')}
        >
          All Providers
          <Badge variant="secondary" className="ml-2">
            {models.filter((m) => (m.providerEnabled ?? true) && m.enabled).length}/{models.length}
          </Badge>
        </Button>
        {providerMeta.map((provider) => {
          const count = models.filter((m) => m.providerId === provider.id).length;
          const providerEnabled = models.filter(
            (m) => m.providerId === provider.id && m.enabled && (m.providerEnabled ?? true)
          ).length;
          return (
            <Button
              key={provider.id}
              variant={selectedProvider === provider.id ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSelectedProvider(provider.id)}
            >
              {provider.name}
              <Badge variant="secondary" className="ml-2">
                {providerEnabled}/{count}
              </Badge>
              {!provider.enabled && (
                <Badge variant="secondary" className="ml-1">
                  off
                </Badge>
              )}
            </Button>
          );
        })}
      </div>

      {selectedProviderMeta && !selectedProviderMeta.enabled && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {selectedProviderMeta.name} is disabled in Providers. Enable it to route traffic to these models.
        </div>
      )}

      {/* Current Models */}
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {selectedProvider ? `${selectedProvider} Models` : 'All Models'}
            <Badge variant="outline">
              {enabledCount} enabled / {filteredModels.length} total
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ModelTable
            models={filteredModels}
            onToggle={handleToggle}
            showProvider={!selectedProvider}
            loading={loading}
            disableToggleWhenProviderDisabled
          />
        </CardContent>
      </Card>
    </div>
  );
}
