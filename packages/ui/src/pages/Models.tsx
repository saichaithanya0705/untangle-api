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

  const providers = Array.from(new Set(models.map((m) => m.providerId)));

  const loadModels = async () => {
    setLoading(true);
    try {
      const data = await api.getFullModels();
      setModels(data);
    } catch (error) {
      console.error('Failed to load models:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadModels();
  }, []);

  const handleToggle = async (model: FullModel, enabled: boolean) => {
    try {
      await api.toggleModel(model.providerId, model.id, enabled);
      setModels((prev) =>
        prev.map((m) =>
          m.id === model.id && m.providerId === model.providerId
            ? { ...m, enabled }
            : m
        )
      );
    } catch (error) {
      console.error('Failed to toggle model:', error);
    }
  };

  const handleRefreshPricing = async () => {
    setRefreshing(true);
    try {
      await api.refreshOpenRouterModels();
      await api.refreshPricing();
      await loadModels();
    } catch (error) {
      console.error('Failed to refresh pricing:', error);
    } finally {
      setRefreshing(false);
    }
  };

  const filteredModels = selectedProvider
    ? models.filter((m) => m.providerId === selectedProvider)
    : models;

  const enabledCount = filteredModels.filter((m) => m.enabled).length;

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

      {/* Info about auto-discovery */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
        <div className="flex items-start gap-3">
          <Info className="text-blue-600 mt-0.5" size={20} />
          <div>
            <h3 className="font-medium text-blue-800">Automatic Model Discovery</h3>
            <p className="text-sm text-blue-700 mt-1">
              Models are automatically discovered when you add an API key for a provider.
              Pricing data is fetched from OpenRouter for accurate cost tracking.
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
            {models.length}
          </Badge>
        </Button>
        {providers.map((providerId) => {
          const count = models.filter((m) => m.providerId === providerId).length;
          const providerEnabled = models.filter(
            (m) => m.providerId === providerId && m.enabled
          ).length;
          return (
            <Button
              key={providerId}
              variant={selectedProvider === providerId ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSelectedProvider(providerId)}
            >
              {providerId}
              <Badge variant="secondary" className="ml-2">
                {providerEnabled}/{count}
              </Badge>
            </Button>
          );
        })}
      </div>

      {/* Current Models */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
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
          />
        </CardContent>
      </Card>
    </div>
  );
}
