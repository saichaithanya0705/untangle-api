import { useState } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { DiscoveredModel } from '@/lib/api';

interface DiscoveredModelListProps {
  models: DiscoveredModel[];
  providerId: string;
  onAddModels?: (models: DiscoveredModel[]) => void;
  loading?: boolean;
}

function formatPrice(price?: number): string {
  if (price === undefined || price === null) return '-';
  if (price < 0.01) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(2)}`;
}

function getSourceBadgeVariant(source: string): 'default' | 'secondary' | 'outline' {
  switch (source) {
    case 'api':
      return 'default';
    case 'openrouter':
      return 'secondary';
    default:
      return 'outline';
  }
}

export function DiscoveredModelList({
  models,
  providerId,
  onAddModels,
  loading = false,
}: DiscoveredModelListProps) {
  const [selectedModels, setSelectedModels] = useState<Set<string>>(new Set());

  const toggleSelection = (modelId: string) => {
    setSelectedModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedModels(new Set(models.map((m) => m.id)));
  };

  const selectNone = () => {
    setSelectedModels(new Set());
  };

  const handleAddSelected = () => {
    if (onAddModels) {
      const selected = models.filter((m) => selectedModels.has(m.id));
      onAddModels(selected);
      setSelectedModels(new Set());
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Discovering models from {providerId}...
        </CardContent>
      </Card>
    );
  }

  if (models.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No models discovered for {providerId}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">
          Discovered Models ({models.length})
        </CardTitle>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={selectAll}>
            Select All
          </Button>
          <Button variant="outline" size="sm" onClick={selectNone}>
            Clear
          </Button>
          {onAddModels && (
            <Button
              size="sm"
              disabled={selectedModels.size === 0}
              onClick={handleAddSelected}
            >
              Add Selected ({selectedModels.size})
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Input/1M</TableHead>
              <TableHead className="text-right">Output/1M</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.map((model) => (
              <TableRow
                key={model.id}
                className={selectedModels.has(model.id) ? 'bg-muted/50' : ''}
              >
                <TableCell>
                  <input
                    type="checkbox"
                    checked={selectedModels.has(model.id)}
                    onChange={() => toggleSelection(model.id)}
                    className="w-4 h-4"
                  />
                </TableCell>
                <TableCell>
                  <div className="font-mono text-sm">{model.id}</div>
                  {model.name && model.name !== model.id && (
                    <div className="text-xs text-muted-foreground">{model.name}</div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant={getSourceBadgeVariant(model.source)}>
                    {model.source}
                  </Badge>
                </TableCell>
                <TableCell className="text-right font-mono text-sm text-green-600">
                  {formatPrice(model.inputPricePer1M)}
                </TableCell>
                <TableCell className="text-right font-mono text-sm text-orange-600">
                  {formatPrice(model.outputPricePer1M)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
