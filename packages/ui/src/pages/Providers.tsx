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

  const loadProviders = async () => {
    setLoading(true);
    try {
      const data = await api.getProviders();
      setProviders(data);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadProviders();
  }, []);

  const toggleProvider = (id: string) => {
    setProviders((prev) =>
      prev.map((p) => (p.id === id ? { ...p, enabled: !p.enabled } : p))
    );
  };

  const refreshProvider = async (id: string) => {
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
    } catch (error) {
      console.error('Failed to refresh provider:', error);
    } finally {
      setRefreshing(null);
    }
  };

  const formatDate = (dateStr?: string | null) => {
    if (!dateStr) return 'Never';
    const date = new Date(dateStr);
    return date.toLocaleString();
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
              No providers configured. Add API keys to enable providers.
            </p>
            <p className="text-sm text-muted-foreground">
              Set environment variables like OPENAI_API_KEY or ANTHROPIC_API_KEY
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Providers</h1>
      <Card>
        <CardHeader>
          <CardTitle>Configured Providers</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
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
                <TableRow key={provider.id}>
                  <TableCell className="font-medium">{provider.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{provider.modelCount}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{provider.source || 'api'}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(provider.lastRefreshed)}
                  </TableCell>
                  <TableCell>
                    {provider.hasKey ? (
                      <CheckCircle className="text-green-500" size={20} />
                    ) : (
                      <XCircle className="text-muted-foreground" size={20} />
                    )}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={provider.enabled}
                      onCheckedChange={() => toggleProvider(provider.id)}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => refreshProvider(provider.id)}
                      disabled={refreshing === provider.id}
                    >
                      <RefreshCw
                        size={16}
                        className={refreshing === provider.id ? 'animate-spin' : ''}
                      />
                      <span className="ml-2">Refresh</span>
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
