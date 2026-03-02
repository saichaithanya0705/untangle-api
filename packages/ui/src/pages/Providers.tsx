import { useEffect, useState } from 'react';
import { CheckCircle, XCircle, RefreshCw } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, Provider } from '@/lib/api';

export default function Providers() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [togglingProvider, setTogglingProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadProviders = async () => {
    setLoading(true);
    try {
      const data = await api.getAllProviders();
      setProviders(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load providers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProviders();
  }, []);

  const toggleProvider = async (id: string, enabled: boolean) => {
    setError(null);
    setNotice(null);
    setTogglingProvider(id);
    setProviders((prev) =>
      prev.map((p) => (p.id === id ? { ...p, enabled } : p))
    );
    try {
      await api.toggleProvider(id, enabled);
      setNotice(`Updated ${providers.find((p) => p.id === id)?.name ?? id}: ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (error) {
      // Revert optimistic update on failure
      setProviders((prev) =>
        prev.map((p) => (p.id === id ? { ...p, enabled: !enabled } : p))
      );
      setError(error instanceof Error ? error.message : 'Failed to toggle provider');
    } finally {
      setTogglingProvider(null);
    }
  };

  const refreshProvider = async (id: string) => {
    setError(null);
    setNotice(null);
    setRefreshing(id);
    try {
      const result = await api.refreshProviderModels(id);
      // Update the provider's model count and refresh time
      setProviders((prev) =>
        prev.map((p) =>
          p.id === id
            ? {
                ...p,
                modelCount: result.count,
                lastRefreshed: new Date().toISOString(),
                source: result.source,
              }
            : p
        )
      );
      setNotice(`Refreshed ${providers.find((p) => p.id === id)?.name ?? id}: ${result.count} models (${result.source}).`);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to refresh provider');
    } finally {
      setRefreshing(null);
    }
  };

  const formatDate = (dateStr?: string | null) => {
    if (!dateStr) return 'Never';
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  const formatSource = (source?: string) => {
    switch (source) {
      case 'api':
        return 'API';
      case 'web-search':
        return 'Web Search';
      case 'openrouter':
        return 'OpenRouter';
      case 'none':
      case undefined:
      case null:
        return 'Not Discovered';
      default:
        return source;
    }
  };

  if (loading) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6">Providers</h1>
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-6">Providers</h1>
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-muted-foreground mb-4">
              No providers available.
            </p>
            <p className="text-sm text-muted-foreground">
              Configure providers in your server config and restart.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Providers</h1>

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

      <Card>
        <CardHeader>
          <CardTitle>All Providers</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            Providers without API keys can still discover public model metadata via web search.
          </p>
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Models</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Last Refreshed</TableHead>
                <TableHead>API Key</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((provider) => (
                <TableRow key={provider.id} className={provider.enabled ? '' : 'opacity-80'}>
                  <TableCell className="font-medium">{provider.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{provider.modelCount}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{formatSource(provider.source)}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(provider.lastRefreshed)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {provider.hasKey ? (
                        <CheckCircle className="text-green-500" size={20} aria-hidden />
                      ) : (
                        <XCircle className="text-muted-foreground" size={20} aria-hidden />
                      )}
                      <span className="text-sm">
                        {provider.hasKey ? 'Key Set' : 'No Key'}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={provider.enabled}
                      aria-label={`Enable provider ${provider.name}`}
                      disabled={togglingProvider === provider.id}
                      onCheckedChange={(checked) => toggleProvider(provider.id, checked)}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => refreshProvider(provider.id)}
                      disabled={refreshing === provider.id || togglingProvider === provider.id}
                    >
                      <RefreshCw
                        size={16}
                        className={refreshing === provider.id ? 'animate-spin' : ''}
                      />
                      <span className="ml-2">{provider.hasKey ? 'Refresh' : 'Discover'}</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
