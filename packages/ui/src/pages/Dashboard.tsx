import { useEffect, useState } from 'react';
import {
  Activity,
  Server,
  Layers,
  Key,
  DollarSign,
  Zap,
  TrendingUp,
  Share2,
  Loader2,
  CheckCircle2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { api, FullModel, Provider, ProviderKey } from '@/lib/api';

interface Stats {
  totalProviders: number;
  enabledProviders: number;
  models: number;
  activeModels: number;
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
    totalProviders: 0,
    enabledProviders: 0,
    models: 0,
    activeModels: 0,
    keysConfigured: 0,
    serverStatus: 'offline',
  });
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [models, setModels] = useState<FullModel[]>([]);
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);

  useEffect(() => {
    async function loadData() {
      try {
        const [fullModels, health, usageData, keysData, providersData] = await Promise.all([
          api.getFullModels().catch(() => []),
          api.getHealth(),
          api.getUsage('today').catch(() => null),
          api.getKeys().catch(() => []),
          api.getAllProviders().catch(() => []),
        ]);

        const activeModels = fullModels.filter(
          (model) => model.enabled && (model.providerEnabled ?? true)
        ).length;
        const configuredKeys = keysData.filter((key) => key.hasKey).length;
        const enabledProviders = providersData.filter((provider) => provider.enabled).length;

        setModels(fullModels);
        setKeys(keysData);
        setProviders(providersData);
        setUsage(usageData);
        setStats({
          totalProviders: providersData.length,
          enabledProviders,
          models: fullModels.length,
          activeModels,
          keysConfigured: configuredKeys,
          serverStatus: health.status,
        });
      } catch {
        setStats((previous) => ({ ...previous, serverStatus: 'offline' }));
      } finally {
        setLoading(false);
      }
    }
    void loadData();
  }, []);

  const modelsByProvider = models.reduce((acc, model) => {
    if (!acc[model.providerId]) {
      acc[model.providerId] = {
        count: 0,
        active: 0,
      };
    }
    acc[model.providerId].count++;
    if (model.enabled && (model.providerEnabled ?? true)) {
      acc[model.providerId].active++;
    }
    return acc;
  }, {} as Record<string, { count: number; active: number }>);

  const providerRows = providers.map((provider) => {
    const modelInfo = modelsByProvider[provider.id] ?? { count: 0, active: 0 };
    return {
      id: provider.id,
      name: provider.name,
      providerEnabled: provider.enabled,
      modelCount: modelInfo.count,
      activeModelCount: modelInfo.active,
      hasKey: keys.find((key) => key.id === provider.id)?.hasKey ?? false,
    };
  });

  const summaryCards = [
    {
      icon: Server,
      label: 'Status',
      value: stats.serverStatus,
      color: stats.serverStatus === 'online' ? 'text-green-500' : 'text-red-500',
    },
    {
      icon: Activity,
      label: 'Providers',
      value: `${stats.enabledProviders}/${stats.totalProviders}`,
      color: 'text-blue-500',
    },
    {
      icon: Layers,
      label: 'Models',
      value: `${stats.activeModels}/${stats.models}`,
      color: 'text-purple-500',
    },
    { icon: Key, label: 'API Keys', value: stats.keysConfigured, color: 'text-yellow-500' },
  ];

  const usageCards = usage
    ? [
        {
          icon: Zap,
          label: 'Requests Today',
          value: usage.totalRequests,
          subtext: `${usage.successfulRequests} success`,
          color: 'text-blue-500',
        },
        {
          icon: TrendingUp,
          label: 'Tokens Used',
          value: formatNumber(usage.totalInputTokens + usage.totalOutputTokens),
          subtext: `${formatNumber(usage.totalInputTokens)} in / ${formatNumber(usage.totalOutputTokens)} out`,
          color: 'text-green-500',
        },
        { icon: DollarSign, label: 'Cost Today', value: formatCost(usage.totalCost), color: 'text-yellow-500' },
      ]
    : [];

  const handleShareSnapshot = async () => {
    setSharing(true);
    setShareError(null);
    setShareNotice(null);
    setShareUrl(null);

    try {
      const { token, expiresAt } = await api.createDashboardShare();
      const nextShareUrl = `${window.location.origin}/shared/dashboard/${token}`;
      setShareUrl(nextShareUrl);

      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(nextShareUrl);
          setShareNotice(`Share link copied. Expires ${new Date(expiresAt).toLocaleString()}.`);
        } catch {
          setShareNotice(`Share link ready. Expires ${new Date(expiresAt).toLocaleString()}.`);
        }
      } else {
        setShareNotice(`Share link ready. Expires ${new Date(expiresAt).toLocaleString()}.`);
      }
    } catch (err) {
      setShareError(err instanceof Error ? err.message : 'Failed to create share link');
    } finally {
      setSharing(false);
    }
  };

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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Providers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {providerRows.map((provider) => (
                <div key={provider.id} className="flex flex-col gap-2 py-2 border-b last:border-0 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-2 h-2 rounded-full ${provider.hasKey ? 'bg-green-500' : 'bg-gray-300'}`} />
                    <span className="font-medium truncate">{provider.name}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    <Badge variant="outline">{provider.activeModelCount}/{provider.modelCount} models</Badge>
                    {provider.providerEnabled ? (
                      <Badge variant="default" className="bg-blue-100 text-blue-800">Enabled</Badge>
                    ) : (
                      <Badge variant="secondary">Disabled</Badge>
                    )}
                    {provider.hasKey ? (
                      <Badge variant="default" className="bg-green-100 text-green-800">Key Set</Badge>
                    ) : (
                      <Badge variant="secondary">No Key</Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Quick Stats</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Total Models</span>
                <span className="font-bold">{stats.models}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Active Models</span>
                <span className="font-bold text-green-600">{stats.activeModels}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Inactive Models</span>
                <span className="font-bold text-gray-400">{stats.models - stats.activeModels}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Enabled Providers</span>
                <span className="font-bold">{stats.enabledProviders} / {stats.totalProviders}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">API Keys Configured</span>
                <span className="font-bold">{stats.keysConfigured} / {stats.totalProviders}</span>
              </div>
              {usage && (
                <>
                  <hr className="my-2" />
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Requests Today</span>
                    <span className="font-bold">{usage.totalRequests}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Success Rate</span>
                    <span className="font-bold text-green-600">
                      {usage.totalRequests > 0
                        ? `${((usage.successfulRequests / usage.totalRequests) * 100).toFixed(0)}%`
                        : '-'}
                    </span>
                  </div>
                </>
              )}
              <hr className="my-2" />
              <div className="space-y-3">
                <div>
                  <p className="font-medium">Share Gateway Snapshot</p>
                  <p className="text-sm text-muted-foreground">
                    Copy a redacted 72-hour link with provider coverage, request volume, and cost totals.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleShareSnapshot}
                  disabled={sharing}
                >
                  {sharing ? (
                    <>
                      <Loader2 className="animate-spin" />
                      Creating Link...
                    </>
                  ) : (
                    <>
                      <Share2 />
                      Copy Share Link
                    </>
                  )}
                </Button>
                {shareNotice && (
                  <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                    <div className="flex items-start gap-2">
                      <CheckCircle2 className="mt-0.5 shrink-0" size={16} />
                      <span>{shareNotice}</span>
                    </div>
                  </div>
                )}
                {shareError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {shareError}
                  </div>
                )}
                {shareUrl && (
                  <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground break-all">
                    {shareUrl}
                  </div>
                )}
              </div>
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
