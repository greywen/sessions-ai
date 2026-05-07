'use client';

import React from 'react';
import { toast } from 'sonner';
import { DollarSign, Coins, Percent } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TimeRangeSelector, getMonthToDateRange, type TimeRangeValue } from '@/components/shared/time-range-selector';
import {
  BarChart, Bar, Cell, LineChart, Line,
  XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { ModelLogo, ToolLogo, getToolLabel } from '@/components/branding/ai-logo';
import {
  ChartContainer, ChartTooltip, ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { useI18n } from '@/lib/i18n/provider';

const CHART_COLORS = ['#1c1c1c', '#386c8c', '#d97706', '#2f7d61', '#b45309', '#5f5f5d'];

interface CostData {
  summary: {
    totalCostUsd: number;
    totalTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheTokens: number;
    cacheHitRate: number;
    totalMessages: number;
  };
  trend: { day: string; sourceTool: string; cost: string; tokens: number }[];
  tokenTrend: {
    day: string;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }[];
  costTrend: { day: string; cost: number }[];
  ranking: { id: string | null; name: string; cost: string; tokens: number; messages: number }[];
  modelDistribution: { model: string | null; cost: string; tokens: number }[];
}

function formatCost(value: number): string {
  // Cost is an estimate based on the latest published pricing; signal that
  // approximation with a leading tilde everywhere it is rendered.
  if (value >= 1000) return `~$${(value / 1000).toFixed(1)}K`;
  return `~$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

const COST_TREND_CHART_CONFIG = {
  cost: { label: 'Cost', color: '#386c8c' },
} satisfies ChartConfig;

const TOKEN_TREND_CHART_CONFIG = {
  totalTokens: { label: 'Total', color: '#1c1c1c' },
  inputTokens: { label: 'Input', color: '#386c8c' },
  outputTokens: { label: 'Output', color: '#2f7d61' },
  cacheReadTokens: { label: 'Cache Read', color: '#d97706' },
  cacheWriteTokens: { label: 'Cache Write', color: '#5f5f5d' },
} satisfies ChartConfig;

const MODEL_DISTRIBUTION_CHART_CONFIG = {
  cost: { label: 'Cost', color: '#2f7d61' },
} satisfies ChartConfig;

export default function CostsPage() {
  const { t } = useI18n();
  const [data, setData] = React.useState<CostData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [range, setRange] = React.useState<TimeRangeValue>(() => getMonthToDateRange());
  const [groupBy, setGroupBy] = React.useState('tool');

  const fetchCosts = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/costs?from=${range.from}&to=${range.to}&groupBy=${groupBy}`);
      if (!res.ok) throw new Error('Failed to get cost data');
      const json = await res.json();
      setData(json.data);
      console.debug('[Expense Summary] Query complete');
    } catch (error) {
      toast.error(t('costs.toast.loadFailed'));
      console.error('[Expense Summary] Request failed:', error);
    } finally {
      setLoading(false);
    }
  }, [range, groupBy, t]);

  React.useEffect(() => { fetchCosts(); }, [fetchCosts]);

  const modelBarData = React.useMemo(() => {
    if (!data?.modelDistribution) return [];
    const rows = data.modelDistribution
      .filter((m) => m.model)
      .map((m, idx) => ({
        model: m.model!,
        cost: Number(m.cost),
        tokens: Number(m.tokens),
        fill: CHART_COLORS[idx % CHART_COLORS.length],
      }))
      .sort((a, b) => b.cost - a.cost);

    const top = rows.slice(0, 8);
    const rest = rows.slice(8);
    if (rest.length > 0) {
      const otherCost = rest.reduce((sum, item) => sum + item.cost, 0);
      const otherTokens = rest.reduce((sum, item) => sum + item.tokens, 0);
      top.push({ model: t('costs.otherModels'), cost: otherCost, tokens: otherTokens, fill: '#9ca3af' });
    }
    return top;
  }, [data?.modelDistribution, t]);

  const formatDayLabel = React.useCallback((value: string) => value.slice(5), []);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <TimeRangeSelector value={range} onChange={setRange} />
      </div>

      {/* Summary Card */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('costs.summary.totalCost')}</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono tabular-nums" title={t('cost.approximate.tooltip')}>
              {formatCost(data?.summary.totalCostUsd ?? 0)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t('costs.summary.totalMessages', { count: formatTokens(data?.summary.totalMessages ?? 0) })}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('costs.summary.totalTokens')}</CardTitle>
            <Coins className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono tabular-nums">
              {formatTokens(data?.summary.totalTokens ?? 0)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t('costs.summary.tokenBreakdown', { input: formatTokens(data?.summary.totalInputTokens ?? 0), output: formatTokens(data?.summary.totalOutputTokens ?? 0) })}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('costs.summary.cacheHitRate')}</CardTitle>
            <Percent className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono tabular-nums">
              {data?.summary.cacheHitRate ?? 0}%
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t('costs.summary.cacheTokens', { tokens: formatTokens(data?.summary.totalCacheTokens ?? 0) })}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Price Usage Trends */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('costs.chart.costTrend')}</CardTitle>
        </CardHeader>
        <CardContent>
          {(data?.costTrend ?? []).length > 0 ? (
            <ChartContainer config={COST_TREND_CHART_CONFIG} className="h-[280px] w-full">
              <LineChart data={data!.costTrend}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} tickFormatter={formatDayLabel} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `$${Number(v).toFixed(3)}`} />
                <ChartTooltip
                  content={(
                    <ChartTooltipContent
                      formatter={(value) => (
                        <div className="flex items-center justify-between gap-4 text-sm">
                          <span className="text-muted-foreground">{t('costs.col.cost')}</span>
                          <span className="font-mono tabular-nums">${Number(value ?? 0).toFixed(4)}</span>
                        </div>
                      )}
                    />
                  )}
                />
                <Line
                  type="monotone"
                  dataKey="cost"
                  stroke="var(--color-cost)"
                  strokeWidth={2.5}
                  dot={{ r: 2 }}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ChartContainer>
          ) : (
            <div className="flex items-center justify-center h-48 text-muted-foreground">
              {t('common.noTrendData')}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Token Statistics */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('costs.chart.tokenStatsTrend')}</CardTitle>
        </CardHeader>
        <CardContent>
          {(data?.tokenTrend ?? []).length > 0 ? (
            <ChartContainer config={TOKEN_TREND_CHART_CONFIG} className="h-[300px] w-full">
              <LineChart data={data!.tokenTrend}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fontSize: 12 }} tickFormatter={formatDayLabel} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => formatTokens(Number(v))} />
                <ChartTooltip
                  content={(
                    <ChartTooltipContent
                      formatter={(value, name) => (
                        <div className="flex items-center justify-between gap-4 text-sm">
                          <span className="text-muted-foreground">{String(name)}</span>
                          <span className="font-mono tabular-nums">{formatTokens(Number(value ?? 0))}</span>
                        </div>
                      )}
                    />
                  )}
                />
                <Bar dataKey="inputTokens" fill="var(--color-inputTokens)" />
                <Bar dataKey="outputTokens" fill="var(--color-outputTokens)" />
                <Bar dataKey="cacheReadTokens" fill="var(--color-cacheReadTokens)" />
                <Bar dataKey="cacheWriteTokens" fill="var(--color-cacheWriteTokens)" />
                <Line type="monotone" dataKey="totalTokens" stroke="var(--color-totalTokens)" strokeWidth={2} dot={false} />
              </LineChart>
            </ChartContainer>
          ) : (
            <div className="flex items-center justify-center h-48 text-muted-foreground">
              {t('costs.chart.empty.token')}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Ranking + Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Fee Ranking */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">{t('costs.ranking.title')}</CardTitle>
            <Tabs value={groupBy} onValueChange={setGroupBy}>
              <TabsList className="h-8">
                <TabsTrigger value="tool" className="text-xs px-2 h-6">{t('costs.ranking.byTool')}</TabsTrigger>
                <TabsTrigger value="user" className="text-xs px-2 h-6">{t('costs.ranking.byUser')}</TabsTrigger>
                <TabsTrigger value="device" className="text-xs px-2 h-6">{t('costs.ranking.byDevice')}</TabsTrigger>
                <TabsTrigger value="model" className="text-xs px-2 h-6">{t('costs.ranking.byModel')}</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('costs.col.name')}</TableHead>
                  <TableHead className="text-right">{t('costs.col.cost')}</TableHead>
                  <TableHead className="text-right">{t('costs.col.tokens')}</TableHead>
                  <TableHead className="text-right">{t('costs.col.messages')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(data?.ranking ?? []).map((item, idx) => (
                  <TableRow key={item.id ?? idx}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        {groupBy === 'tool' && <ToolLogo tool={item.name} size={16} />}
                        {groupBy === 'model' && <ModelLogo model={item.name} size={16} />}
                        <span>{groupBy === 'tool' ? getToolLabel(item.name) : item.name ?? t('common.notAvailable')}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatCost(Number(item.cost))}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{formatTokens(item.tokens)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">{item.messages}</TableCell>
                  </TableRow>
                ))}
                {(data?.ranking ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                      {t('costs.empty.noData')}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Model Distribution Bar Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('costs.chart.modelDistribution')}</CardTitle>
          </CardHeader>
          <CardContent>
            {modelBarData.length > 0 ? (
              <ChartContainer config={MODEL_DISTRIBUTION_CHART_CONFIG} className="h-[320px] w-full">
                <BarChart data={modelBarData} layout="vertical" margin={{ left: 8, right: 12 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => formatCost(Number(v))} />
                  <YAxis
                    dataKey="model"
                    type="category"
                    width={92}
                    tick={{ fontSize: 11 }}
                    tickFormatter={(value: string) => (value.length > 14 ? `${value.slice(0, 14)}...` : value)}
                  />
                  <ChartTooltip
                    content={(
                      <ChartTooltipContent
                        formatter={(value, _name, item) => (
                          <div className="flex items-center justify-between gap-4 text-sm">
                            <span className="text-muted-foreground">{String(item?.payload?.model ?? '')}</span>
                            <span className="font-mono tabular-nums">{formatCost(Number(value ?? 0))}</span>
                          </div>
                        )}
                      />
                    )}
                  />
                  <Bar dataKey="cost" radius={[0, 6, 6, 0]}>
                    {modelBarData.map((entry) => (
                      <Cell key={entry.model} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartContainer>
            ) : (
              <div className="flex items-center justify-center h-48 text-muted-foreground">
                {t('costs.empty.noData')}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
