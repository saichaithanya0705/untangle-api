const BASE_URL = '';

async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    credentials: init?.credentials ?? 'same-origin',
  });
}

export interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

export interface ModelsResponse {
  object: string;
  data: Model[];
}

export interface FullModel {
  id: string;
  alias?: string;
  providerId: string;
  providerName: string;
  providerEnabled?: boolean;
  contextWindow: number;
  maxOutputTokens: number;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
  capabilities: string[];
  enabled: boolean;
}

export interface DiscoveredModel {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
  capabilities?: string[];
  source: 'api' | 'web-search' | 'openrouter' | 'hardcoded';
}

export interface Provider {
  id: string;
  name: string;
  enabled: boolean;
  modelCount: number;
  hasKey: boolean;
  configured: boolean;
  lastRefreshed?: string | null;
  source?: string;
}

export interface ProviderKey {
  id: string;
  name: string;
  hasKey: boolean;
  envVar: string;
}

export interface ServerHealth {
  status: 'online' | 'offline';
  version?: string;
}

export interface ServerSettings {
  server: {
    host: string;
    port: number;
  };
  observability?: {
    level: string;
    tracingEnabled: boolean;
  };
  ui?: {
    enabled: boolean;
  };
}

export interface DiscoveryResult {
  providerId: string;
  models: DiscoveredModel[];
  count: number;
  source: string;
}

interface ProvidersResponse {
  providers: Provider[];
}

interface KeysResponse {
  providers: ProviderKey[];
}

export interface UsageRecord {
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

export interface DashboardShareProvider {
  id: string;
  name: string;
  enabled: boolean;
  hasKey: boolean;
  activeModels: number;
  totalModels: number;
}

export interface DashboardShareTopProvider {
  id: string;
  name: string;
  requests: number;
  totalCost: number;
}

export interface DashboardShareSnapshot {
  generatedAt: string;
  expiresAt: string;
  summary: {
    serverStatus: 'online';
    totalProviders: number;
    enabledProviders: number;
    totalModels: number;
    activeModels: number;
    keysConfigured: number;
    totalRequests: number;
    successfulRequests: number;
    totalTokens: number;
    totalCost: number;
  };
  providers: DashboardShareProvider[];
  topProviders: DashboardShareTopProvider[];
}

export const api = {
  async createAdminSession(adminKey: string): Promise<{ authenticated: boolean; expiresAt: string }> {
    const res = await apiFetch(`${BASE_URL}/api/admin/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminKey }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message || 'Failed to create admin session');
    }
    return res.json();
  },

  async deleteAdminSession(): Promise<void> {
    const res = await apiFetch(`${BASE_URL}/api/admin/session`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to end admin session');
  },

  // Models
  async getModels(): Promise<Model[]> {
    const res = await apiFetch(`${BASE_URL}/v1/models`);
    if (!res.ok) throw new Error('Failed to fetch models');
    const data: ModelsResponse = await res.json();
    return data.data || [];
  },

  async getFullModels(): Promise<FullModel[]> {
    const res = await apiFetch(`${BASE_URL}/api/models/full`);
    if (!res.ok) throw new Error('Failed to fetch full models');
    const data = await res.json();
    return data.models || [];
  },

  async toggleModel(providerId: string, modelId: string, enabled: boolean): Promise<void> {
    const res = await apiFetch(`${BASE_URL}/api/models/${providerId}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId, enabled }),
    });
    if (!res.ok) throw new Error('Failed to toggle model');
  },

  // Discovery
  async discoverModels(providerId: string): Promise<DiscoveryResult> {
    const res = await apiFetch(`${BASE_URL}/api/discover/${providerId}`);
    if (!res.ok) throw new Error('Failed to discover models');
    return res.json();
  },

  async discoverAllModels(): Promise<Record<string, { models: DiscoveredModel[]; source: string }>> {
    const res = await apiFetch(`${BASE_URL}/api/discover/all`);
    if (!res.ok) throw new Error('Failed to discover all models');
    const data = await res.json();
    return data.results;
  },

  async refreshOpenRouterModels(): Promise<{ count: number }> {
    const res = await apiFetch(`${BASE_URL}/api/discover/openrouter/refresh`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to refresh OpenRouter models');
    return res.json();
  },

  async getOpenRouterModels(providerId: string): Promise<DiscoveredModel[]> {
    const res = await apiFetch(`${BASE_URL}/api/discover/openrouter/${providerId}`);
    if (!res.ok) throw new Error('Failed to fetch OpenRouter models');
    const data = await res.json();
    return data.models || [];
  },

  async addModels(providerId: string, models: DiscoveredModel[]): Promise<void> {
    const res = await apiFetch(`${BASE_URL}/api/models/${providerId}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models }),
    });
    if (!res.ok) throw new Error('Failed to add models');
  },

  // Providers - enabled providers only
  async getProviders(): Promise<Provider[]> {
    const res = await apiFetch(`${BASE_URL}/api/providers`);
    if (!res.ok) throw new Error('Failed to fetch providers');
    const data = await res.json() as ProvidersResponse;
    return (data.providers || []).map((p) => ({
      ...p,
      hasKey: p.configured,
    }));
  },

  // Get all providers including unconfigured ones
  async getAllProviders(): Promise<Provider[]> {
    const res = await apiFetch(`${BASE_URL}/api/providers/all`);
    if (!res.ok) throw new Error('Failed to fetch all providers');
    const data = await res.json() as ProvidersResponse;
    return (data.providers || []).map((p) => ({
      ...p,
      hasKey: p.configured,
    }));
  },

  async toggleProvider(providerId: string, enabled: boolean): Promise<void> {
    const res = await apiFetch(`${BASE_URL}/api/providers/${providerId}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error('Failed to toggle provider');
  },

  // Refresh models for a provider (triggers web search if no API)
  async refreshProviderModels(providerId: string): Promise<DiscoveryResult> {
    const res = await apiFetch(`${BASE_URL}/api/discover/${providerId}/refresh`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error('Failed to refresh models');
    return res.json();
  },

  // Keys
  async getKeys(): Promise<ProviderKey[]> {
    const res = await apiFetch(`${BASE_URL}/api/keys`);
    if (!res.ok) throw new Error('Failed to fetch keys');
    const data = await res.json() as KeysResponse;
    return data.providers || [];
  },

  async setKey(providerId: string, apiKey: string): Promise<void> {
    const res = await apiFetch(`${BASE_URL}/api/keys/${providerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    if (!res.ok) throw new Error('Failed to set key');
  },

  async removeKey(providerId: string): Promise<void> {
    const res = await apiFetch(`${BASE_URL}/api/keys/${providerId}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to remove key');
  },

  async testKey(providerId: string): Promise<{ success: boolean; message?: string; error?: { message?: string } }> {
    const res = await apiFetch(`${BASE_URL}/api/keys/${providerId}/test`, {
      method: 'POST',
    });
    return res.json();
  },

  // Health
  async getHealth(): Promise<ServerHealth> {
    try {
      const res = await apiFetch(`${BASE_URL}/health`);
      if (res.ok) {
        return { status: 'online' };
      }
      return { status: 'offline' };
    } catch {
      return { status: 'offline' };
    }
  },

  async getSettings(): Promise<ServerSettings> {
    const res = await apiFetch(`${BASE_URL}/api/settings`);
    if (!res.ok) throw new Error('Failed to fetch settings');
    return res.json();
  },

  async createDashboardShare(): Promise<{ token: string; expiresAt: string }> {
    const res = await apiFetch(`${BASE_URL}/api/dashboard/share`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error('Failed to create share link');
    return res.json();
  },

  async getDashboardShare(token: string): Promise<DashboardShareSnapshot> {
    const res = await apiFetch(`${BASE_URL}/public/dashboard-share/${token}`);
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(body?.error?.message || 'Failed to load shared snapshot');
    }
    const data = await res.json() as { snapshot: DashboardShareSnapshot };
    return data.snapshot;
  },

  // Pricing
  async getPricing(): Promise<{ pricing: Array<{ modelId: string; providerId: string; inputPricePer1M: number; outputPricePer1M: number }> }> {
    const res = await apiFetch(`${BASE_URL}/api/pricing`);
    if (!res.ok) throw new Error('Failed to fetch pricing');
    return res.json();
  },

  async refreshPricing(): Promise<{ message: string; pricing: Array<{ modelId: string; providerId: string; inputPricePer1M: number; outputPricePer1M: number }> }> {
    const res = await apiFetch(`${BASE_URL}/api/pricing/refresh`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to refresh pricing');
    return res.json();
  },

  // Usage
  async getUsage(period: string = 'today'): Promise<{
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    byProvider: Record<string, { requests: number; inputTokens: number; outputTokens: number; cost: number }>;
    byModel: Record<string, { requests: number; inputTokens: number; outputTokens: number; cost: number }>;
  }> {
    const res = await apiFetch(`${BASE_URL}/api/usage?period=${period}`);
    if (!res.ok) throw new Error('Failed to fetch usage');
    const data = await res.json();
    const totalCost = typeof data.totalCost === 'number'
      ? data.totalCost
      : (typeof data.totalCostUsd === 'number' ? data.totalCostUsd : 0);
    return { ...data, totalCost };
  },

  async getUsageRecords(limit: number = 50): Promise<{ records: UsageRecord[] }> {
    const res = await apiFetch(`${BASE_URL}/api/usage/records?limit=${limit}`);
    if (!res.ok) throw new Error('Failed to fetch usage records');
    return res.json();
  },
};
