import { useEffect, useState } from 'react';
import { BarChart3, DollarSign, Zap, Clock, TrendingUp } from 'lucide-react';

interface UsageSummary {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  byProvider: Record<string, {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }>;
  byModel: Record<string, {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }>;
}

interface UsageRecord {
  id: string;
  timestamp: string;
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  durationMs: number;
  success: boolean;
}

function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `$${cost.toFixed(6)}`;
  }
  return `$${cost.toFixed(4)}`;
}

function formatNumber(num: number): string {
  if (num >= 1_000_000) {
    return `${(num / 1_000_000).toFixed(2)}M`;
  }
  if (num >= 1_000) {
    return `${(num / 1_000).toFixed(1)}K`;
  }
  return num.toString();
}

export default function Usage() {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [period, setPeriod] = useState('today');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/usage?period=${period}`).then(r => r.json()),
      fetch('/api/usage/records?limit=50').then(r => r.json()),
    ])
      .then(([summaryData, recordsData]) => {
        setSummary(summaryData);
        setRecords(recordsData.records || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [period]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading usage data...</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Usage & Costs</h1>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="px-3 py-2 border rounded-lg bg-white"
        >
          <option value="hour">Last Hour</option>
          <option value="today">Today</option>
          <option value="all">All Time</option>
        </select>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center gap-4">
            <Zap className="text-blue-500" size={24} />
            <div>
              <p className="text-gray-500 text-sm">Requests</p>
              <p className="text-2xl font-bold">{summary?.totalRequests ?? 0}</p>
              <p className="text-xs text-gray-400">
                {summary?.successfulRequests ?? 0} success / {summary?.failedRequests ?? 0} failed
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center gap-4">
            <BarChart3 className="text-purple-500" size={24} />
            <div>
              <p className="text-gray-500 text-sm">Input Tokens</p>
              <p className="text-2xl font-bold">{formatNumber(summary?.totalInputTokens ?? 0)}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center gap-4">
            <TrendingUp className="text-green-500" size={24} />
            <div>
              <p className="text-gray-500 text-sm">Output Tokens</p>
              <p className="text-2xl font-bold">{formatNumber(summary?.totalOutputTokens ?? 0)}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center gap-4">
            <DollarSign className="text-yellow-500" size={24} />
            <div>
              <p className="text-gray-500 text-sm">Total Cost</p>
              <p className="text-2xl font-bold">{formatCost(summary?.totalCost ?? 0)}</p>
            </div>
          </div>
        </div>
      </div>

      {/* By Provider */}
      {summary?.byProvider && Object.keys(summary.byProvider).length > 0 && (
        <div className="bg-white rounded-lg shadow p-6 mb-8">
          <h2 className="text-lg font-semibold mb-4">Usage by Provider</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Provider</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Requests</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Input Tokens</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Output Tokens</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {Object.entries(summary.byProvider).map(([provider, data]) => (
                  <tr key={provider}>
                    <td className="px-4 py-3 font-medium capitalize">{provider}</td>
                    <td className="px-4 py-3 text-right">{data.requests}</td>
                    <td className="px-4 py-3 text-right">{formatNumber(data.inputTokens)}</td>
                    <td className="px-4 py-3 text-right">{formatNumber(data.outputTokens)}</td>
                    <td className="px-4 py-3 text-right">{formatCost(data.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* By Model */}
      {summary?.byModel && Object.keys(summary.byModel).length > 0 && (
        <div className="bg-white rounded-lg shadow p-6 mb-8">
          <h2 className="text-lg font-semibold mb-4">Usage by Model</h2>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Requests</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Input Tokens</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Output Tokens</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {Object.entries(summary.byModel).map(([model, data]) => (
                  <tr key={model}>
                    <td className="px-4 py-3 font-mono text-sm">{model}</td>
                    <td className="px-4 py-3 text-right">{data.requests}</td>
                    <td className="px-4 py-3 text-right">{formatNumber(data.inputTokens)}</td>
                    <td className="px-4 py-3 text-right">{formatNumber(data.outputTokens)}</td>
                    <td className="px-4 py-3 text-right">{formatCost(data.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Recent Requests */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold mb-4">Recent Requests</h2>
        {records.length === 0 ? (
          <p className="text-gray-500 text-center py-8">No requests recorded yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Time</th>
                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Tokens</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Cost</th>
                  <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase">Duration</th>
                  <th className="px-4 py-2 text-center text-xs font-medium text-gray-500 uppercase">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {records.slice().reverse().map((record) => (
                  <tr key={record.id}>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {new Date(record.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="px-4 py-3 font-mono text-sm">{record.modelId}</td>
                    <td className="px-4 py-3 text-right text-sm">
                      {record.inputTokens} / {record.outputTokens}
                    </td>
                    <td className="px-4 py-3 text-right text-sm">{formatCost(record.totalCost)}</td>
                    <td className="px-4 py-3 text-right text-sm">{record.durationMs}ms</td>
                    <td className="px-4 py-3 text-center">
                      {record.success ? (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-green-100 text-green-800">
                          Success
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs bg-red-100 text-red-800">
                          Failed
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
