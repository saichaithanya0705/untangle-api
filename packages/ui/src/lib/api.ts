const BASE_URL = '';

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

export interface DiscoveryResult {
  providerId: string;
  models: DiscoveredModel[];
  count: number;
  source: string;
}

export const api = {
  // Models
  async getModels(): Promise<Model[]> {
    const res = await fetch(`${BASE_URL}/v1/models`);
    if (!res.ok) throw new Error('Failed to fetch models');
    const data: ModelsResponse = await res.json();
    return data.data || [];
  },

  async getFullModels(): Promise<FullModel[]> {
    const res = await fetch(`${BASE_URL}/api/models/full`);
    if (!res.ok) throw new Error('Failed to fetch full models');
    const data = await res.json();
    return data.models || [];
  },

  async toggleModel(providerId: string, modelId: string, enabled: boolean): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/models/${providerId}/${modelId}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error('Failed to toggle model');
  },

  // Discovery
  async discoverModels(providerId: string): Promise<DiscoveryResult> {
    const res = await fetch(`${BASE_URL}/api/discover/${providerId}`);
    if (!res.ok) throw new Error('Failed to discover models');
    return res.json();
  },

  async discoverAllModels(): Promise<Record<string, DiscoveredModel[]>> {
    const res = await fetch(`${BASE_URL}/api/discover/all`);
    if (!res.ok) throw new Error('Failed to discover all models');
    const data = await res.json();
    return data.results;
  },

  async refreshOpenRouterModels(): Promise<{ count: number }> {
    const res = await fetch(`${BASE_URL}/api/discover/openrouter/refresh`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to refresh OpenRouter models');
    return res.json();
  },

  async getOpenRouterModels(providerId: string): Promise<DiscoveredModel[]> {
    const res = await fetch(`${BASE_URL}/api/discover/openrouter/${providerId}`);
    if (!res.ok) throw new Error('Failed to fetch OpenRouter models');
    const data = await res.json();
    return data.models || [];
  },

  async addModels(providerId: string, models: DiscoveredModel[]): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/models/${providerId}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models }),
    });
    if (!res.ok) throw new Error('Failed to add models');
  },

  // Providers - only return configured providers (those with API keys)
  async getProviders(): Promise<Provider[]> {
    const res = await fetch(`${BASE_URL}/api/providers`);
    if (!res.ok) throw new Error('Failed to fetch providers');
    const data = await res.json();
    return (data.providers || []).map((p: any) => ({
      ...p,
      hasKey: true, // All providers from this endpoint have keys
      configured: true,
    }));
  },

  async toggleProvider(providerId: string, enabled: boolean): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/providers/${providerId}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error('Failed to toggle provider');
  },

  // Get all providers including unconfigured ones
  async getAllProviders(): Promise<Provider[]> {
    const res = await fetch(`${BASE_URL}/api/providers/all`);
    if (!res.ok) throw new Error('Failed to fetch all providers');
    const data = await res.json();
    return (data.providers || []).map((p: any) => ({
      ...p,
      hasKey: p.configured,
    }));
  },

  // Refresh models for a provider (triggers web search if no API)
  async refreshProviderModels(providerId: string): Promise<DiscoveryResult> {
    const res = await fetch(`${BASE_URL}/api/discover/${providerId}/refresh`, {
      method: 'POST',
    });
    if (!res.ok) throw new Error('Failed to refresh models');
    return res.json();
  },

  // Keys
  async getKeys(): Promise<ProviderKey[]> {
    const res = await fetch(`${BASE_URL}/api/keys`);
    if (!res.ok) throw new Error('Failed to fetch keys');
    const data = await res.json();
    return data.providers || [];
  },

  async setKey(providerId: string, apiKey: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/keys/${providerId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    if (!res.ok) throw new Error('Failed to set key');
  },

  async removeKey(providerId: string): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/keys/${providerId}`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('Failed to remove key');
  },

  // Health
  async getHealth(): Promise<ServerHealth> {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) {
        return { status: 'online' };
      }
      return { status: 'offline' };
    } catch {
      return { status: 'offline' };
    }
  },

  // Pricing
  async getPricing(): Promise<{ prices: Array<{ modelId: string; providerId: string; inputPricePer1M: number; outputPricePer1M: number }> }> {
    const res = await fetch(`${BASE_URL}/api/pricing`);
    if (!res.ok) throw new Error('Failed to fetch pricing');
    return res.json();
  },

  async refreshPricing(): Promise<{ size: number }> {
    const res = await fetch(`${BASE_URL}/api/pricing/refresh`, { method: 'POST' });
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
    const res = await fetch(`${BASE_URL}/api/usage?period=${period}`);
    if (!res.ok) throw new Error('Failed to fetch usage');
    return res.json();
  },
};
