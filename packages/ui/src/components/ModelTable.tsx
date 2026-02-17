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
import type { FullModel } from '@/lib/api';

interface ModelTableProps {
  models: FullModel[];
  onToggle?: (model: FullModel, enabled: boolean) => void;
  showProvider?: boolean;
  showPricing?: boolean;
  loading?: boolean;
}

function formatPrice(price?: number): string {
  if (price === undefined || price === null) return '-';
  if (price < 0.01) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(2)}`;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
  return tokens.toString();
}

export function ModelTable({
  models,
  onToggle,
  showProvider = true,
  showPricing = true,
  loading = false,
}: ModelTableProps) {
  if (loading) {
    return <div className="text-muted-foreground py-8 text-center">Loading models...</div>;
  }

  if (models.length === 0) {
    return <div className="text-muted-foreground py-8 text-center">No models available</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Model</TableHead>
          {showProvider && <TableHead>Provider</TableHead>}
          <TableHead className="text-right">Context</TableHead>
          {showPricing && (
            <>
              <TableHead className="text-right">Input/1M</TableHead>
              <TableHead className="text-right">Output/1M</TableHead>
            </>
          )}
          <TableHead>Capabilities</TableHead>
          <TableHead className="text-center">Enabled</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.map((model) => (
          <TableRow key={`${model.providerId}-${model.id}`}>
            <TableCell>
              <div className="font-mono text-sm">{model.id}</div>
              {model.alias && (
                <div className="text-xs text-muted-foreground">alias: {model.alias}</div>
              )}
            </TableCell>
            {showProvider && (
              <TableCell>
                <Badge variant="outline">{model.providerName}</Badge>
              </TableCell>
            )}
            <TableCell className="text-right font-mono text-sm">
              {formatContext(model.contextWindow)}
            </TableCell>
            {showPricing && (
              <>
                <TableCell className="text-right font-mono text-sm text-green-600">
                  {formatPrice(model.inputPricePer1M)}
                </TableCell>
                <TableCell className="text-right font-mono text-sm text-orange-600">
                  {formatPrice(model.outputPricePer1M)}
                </TableCell>
              </>
            )}
            <TableCell>
              <div className="flex gap-1 flex-wrap">
                {model.capabilities.map((cap) => (
                  <Badge key={cap} variant="secondary" className="text-xs">
                    {cap}
                  </Badge>
                ))}
              </div>
            </TableCell>
            <TableCell className="text-center">
              {onToggle ? (
                <Switch
                  checked={model.enabled}
                  onCheckedChange={(checked) => onToggle(model, checked)}
                />
              ) : (
                <Badge variant={model.enabled ? 'default' : 'outline'}>
                  {model.enabled ? 'Yes' : 'No'}
                </Badge>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
