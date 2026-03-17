import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Activity, Clock3, DollarSign, KeyRound, Layers, Server } from 'lucide-react';
import { api, type DashboardShareSnapshot } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function SharedDashboard() {
  const { token } = useParams();
  const [snapshot, setSnapshot] = useState<DashboardShareSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setError('This snapshot link is invalid.');
      setLoading(false);
      return;
    }

    setLoading(true);
    api.getDashboardShare(token)
      .then((data) => {
        setSnapshot(data);
        setError(null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to load shared snapshot');
      })
      .finally(() => {
        setLoading(false);
      });
  }, [token]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-100 p-6">
        <div className="text-sm text-muted-foreground">Loading shared gateway snapshot...</div>
      </div>
    );
  }

  if (error || !snapshot) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-100 p-6">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>Snapshot unavailable</CardTitle>
            <CardDescription>{error ?? 'This share link is no longer available.'}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link to="/">Open untangle-ai</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const successRate = snapshot.summary.totalRequests > 0
    ? Math.round((snapshot.summary.successfulRequests / snapshot.summary.totalRequests) * 100)
    : 0;

  const summaryCards = [
    {
      icon: Server,
      label: 'Server',
      value: 'Online',
      subtext: `${snapshot.summary.enabledProviders}/${snapshot.summary.totalProviders} providers enabled`,
    },
    {
      icon: Activity,
      label: 'Models',
      value: `${snapshot.summary.activeModels}/${snapshot.summary.totalModels}`,
      subtext: 'active models',
    },
    {
      icon: KeyRound,
      label: 'Keys',
      value: snapshot.summary.keysConfigured.toString(),
      subtext: 'providers configured',
    },
    {
      icon: Clock3,
      label: 'Requests Today',
      value: snapshot.summary.totalRequests.toString(),
      subtext: `${successRate}% success rate`,
    },
    {
      icon: Layers,
      label: 'Tokens Today',
      value: formatNumber(snapshot.summary.totalTokens),
      subtext: 'input + output tokens',
    },
    {
      icon: DollarSign,
      label: 'Cost Today',
      value: formatCost(snapshot.summary.totalCost),
      subtext: 'redacted shared total',
    },
  ];

  return (
    <div className="min-h-screen bg-gray-100 p-4 sm:p-6 md:p-8">
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <div className="flex flex-col gap-4 rounded-2xl bg-gray-900 p-6 text-white shadow-lg sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-3">
            <Badge variant="outline" className="border-white/30 text-white">
              Shared Snapshot
            </Badge>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">untangle-ai Gateway Snapshot</h1>
              <p className="mt-2 max-w-2xl text-sm text-gray-300">
                This view shares setup health and live usage without exposing API keys,
                admin settings, or internal routing configuration.
              </p>
            </div>
          </div>
          <div className="space-y-1 text-sm text-gray-300">
            <div>Generated {formatDateTime(snapshot.generatedAt)}</div>
            <div>Expires {formatDateTime(snapshot.expiresAt)}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {summaryCards.map(({ icon: Icon, label, value, subtext }) => {
            return (
              <Card key={label}>
                <CardContent className="flex items-start gap-4 pt-6">
                  <Icon className="mt-0.5 text-blue-600" size={22} />
                  <div>
                    <p className="text-sm text-muted-foreground">{label}</p>
                    <p className="text-2xl font-semibold">{value}</p>
                    <p className="text-xs text-muted-foreground">{subtext}</p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.4fr,1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Provider Coverage</CardTitle>
              <CardDescription>
                Enabled providers, key coverage, and active model counts.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {snapshot.providers.map((provider) => (
                <div
                  key={provider.id}
                  className="flex flex-col gap-2 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="font-medium">{provider.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {provider.activeModels}/{provider.totalModels} active models
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {provider.enabled ? (
                      <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">Enabled</Badge>
                    ) : (
                      <Badge variant="secondary">Disabled</Badge>
                    )}
                    {provider.hasKey ? (
                      <Badge className="bg-green-100 text-green-800 hover:bg-green-100">Key Set</Badge>
                    ) : (
                      <Badge variant="secondary">No Key</Badge>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Traffic Leaders</CardTitle>
              <CardDescription>
                Top providers by today&apos;s request volume in this shared window.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {snapshot.topProviders.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                  No requests have been recorded yet.
                </div>
              ) : (
                snapshot.topProviders.map((provider, index) => (
                  <div key={provider.id} className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">
                        {index + 1}. {provider.name}
                      </p>
                      <p className="text-sm text-muted-foreground">{provider.requests} requests</p>
                    </div>
                    <div className="text-right text-sm">
                      <div className="font-medium">{formatCost(provider.totalCost)}</div>
                      <div className="text-muted-foreground">today</div>
                    </div>
                  </div>
                ))
              )}

              <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                Snapshot links are short-lived and intentionally redacted. Share them to show
                that the gateway is configured and actively serving traffic.
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toString();
}

function formatCost(value: number): string {
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}
