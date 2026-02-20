import { useEffect, useState } from 'react';
import { Activity, Server, Layers, Key, DollarSign, Zap, TrendingUp, Clock } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api, FullModel, ProviderKey } from '@/lib/api';

interface Stats {
  providers: number;
  models: number;
  enabledModels: number;
  keysConfigured: number;
  serverStatus: 'online' | 'offline';
}

interface UsageStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats>({
    providers: 0,
    models: 0,
    enabledModels: 0,
    keysConfigured: 0,
    serverStatus: 'offline',
  });
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [models, setModels] = useState<FullModel[]>([]);
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const [fullModels, health, usageData, keysData] = await Promise.all([
          api.getFullModels().catch(() => []),
          api.getHealth(),
          api.getUsage('today').catch(() => null),
          api.getKeys().catch(() => []),
        ]);

        const providers = new Set(fullModels.map((m) => m.providerId));
        const enabledModels = fullModels.filter((m) => m.enabled).length;
        const configuredKeys = keysData.filter((k) => k.hasKey).length;

        setModels(fullModels);
        setKeys(keysData);
        setUsage(usageData);
        setStats({
          providers: providers.size,
          models: fullModels.length,
          enabledModels,
          keysConfigured: configuredKeys,
          serverStatus: health.status,
        });
      } catch {
        setStats((s) => ({ ...s, serverStatus: 'offline' }));
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  // Group models by provider
  const modelsByProvider = models.reduce((acc, model) => {
    if (!acc[model.providerId]) {
      acc[model.providerId] = { name: model.providerName, count: 0, enabled: 0 };
    }
    acc[model.providerId].count++;
    if (model.enabled) acc[model.providerId].enabled++;
    return acc;
  }, {} as Record<string, { name: string; count: number; enabled: number }>);

  const summaryCards = [
    {
      icon: Server,
      label: 'Status',
      value: stats.serverStatus,
      color: stats.serverStatus === 'online' ? 'text-green-500' : 'text-red-500',
    },
    { icon: Activity, label: 'Providers', value: stats.providers, color: 'text-blue-500' },
    { icon: Layers, label: 'Models', value: `${stats.enabledModels}/${stats.models}`, color: 'text-purple-500' },
    { icon: Key, label: 'API Keys', value: stats.keysConfigured, color: 'text-yellow-500' },
  ];

  const usageCards = usage ? [
    { icon: Zap, label: 'Requests Today', value: usage.totalRequests, subtext: `${usage.successfulRequests} success`, color: 'text-blue-500' },
    { icon: TrendingUp, label: 'Tokens Used', value: formatNumber(usage.totalInputTokens + usage.totalOutputTokens), subtext: `${formatNumber(usage.totalInputTokens)} in / ${formatNumber(usage.totalOutputTokens)} out`, color: 'text-green-500' },
    { icon: DollarSign, label: 'Cost Today', value: formatCost(usage.totalCost), color: 'text-yellow-500' },
  ] : [];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted-foreground">Loading dashboard...</div>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {summaryCards.map(({ icon: Icon, label, value, color }) => (
          <Card key={label}>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <Icon className={color} size={24} />
                <div>
                  <p className="text-muted-foreground text-sm">{label}</p>
                  <p className="text-2xl font-bold capitalize">{value}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Usage Stats (if available) */}
      {usage && usage.totalRequests > 0 && (
        <>
          <h2 className="text-lg font-semibold mb-4">Today's Usage</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
            {usageCards.map(({ icon: Icon, label, value, subtext, color }) => (
              <Card key={label}>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-4">
                    <Icon className={color} size={24} />
                    <div>
                      <p className="text-muted-foreground text-sm">{label}</p>
                      <p className="text-2xl font-bold">{value}</p>
                      {subtext && <p className="text-xs text-muted-foreground">{subtext}</p>}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* Providers Overview */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Providers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Object.entries(modelsByProvider).map(([id, { name, count, enabled }]) => {
                const keyInfo = keys.find((k) => k.id === id);
                return (
                  <div key={id} className="flex items-center justify-between py-2 border-b last:border-0">
                    <div className="flex items-center gap-3">
                      <div className={`w-2 h-2 rounded-full ${keyInfo?.hasKey ? 'bg-green-500' : 'bg-gray-300'}`} />
                      <span className="font-medium">{name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{enabled}/{count} models</Badge>
                      {keyInfo?.hasKey ? (
                        <Badge variant="default" className="bg-green-100 text-green-800">Key Set</Badge>
                      ) : (
                        <Badge variant="secondary">No Key</Badge>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Quick Stats</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Total Models</span>
                <span className="font-bold">{stats.models}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Enabled Models</span>
                <span className="font-bold text-green-600">{stats.enabledModels}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Disabled Models</span>
                <span className="font-bold text-gray-400">{stats.models - stats.enabledModels}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">API Keys Configured</span>
                <span className="font-bold">{stats.keysConfigured} / {stats.providers}</span>
              </div>
              {usage && (
                <>
                  <hr className="my-2" />
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Requests Today</span>
                    <span className="font-bold">{usage.totalRequests}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Success Rate</span>
                    <span className="font-bold text-green-600">
                      {usage.totalRequests > 0
                        ? `${((usage.successfulRequests / usage.totalRequests) * 100).toFixed(0)}%`
                        : '-'}
                    </span>
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function formatNumber(num: number): string {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toString();
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(6)}`;
  return `$${cost.toFixed(4)}`;
}
