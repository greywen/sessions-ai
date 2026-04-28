'use client';

import React from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpFromLine,
  Cpu,
  DatabaseZap,
  DollarSign,
  Hash,
  MessageSquare,
  Monitor,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TimeRangeSelector, getDefaultRange, type TimeRangeValue } from '@/components/shared/time-range-selector';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from 'recharts';
import { TOOL_COLORS } from '@sessions-ai/shared';
import { formatDistanceToNow } from 'date-fns';
import { ToolLogo, getToolLabel } from '@/components/branding/ai-logo';
import { useI18n } from '@/lib/i18n/provider';
import { dateFnsLocale } from '@/lib/i18n/date-locale';
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';

const CHART_COLORS = ['#1c1c1c', '#386c8c', '#d97706', '#2f7d61', '#b45309'];

const TOKEN_TREND_CHART_CONFIG = {
  totalTokens: { label: 'Total', color: '#1c1c1c' },
  inputTokens: { label: 'Input', color: '#386c8c' },
  outputTokens: { label: 'Output', color: '#2f7d61' },
  cacheReadTokens: { label: 'Cache Read', color: '#d97706' },
  cacheWriteTokens: { label: 'Cache Write', color: '#5f5f5d' },
} satisfies ChartConfig;

const COST_TREND_CHART_CONFIG = {
  cost: { label: 'Cost', color: '#386c8c' },
} satisfies ChartConfig;

const TOOL_DISTRIBUTION_CHART_CONFIG = {
  messageCount: { label: '# of Messages', color: '#2f7d61' },
} satisfies ChartConfig;

function formatTokenCount(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

interface DashboardData {
  activeDevices: number;
  totalDevices: number;
  sessionCount: number;
  messageCount: number;
  totalCostUsd: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  growth: { sessions: number; messages: number; cost: number };
  toolDistribution: { sourceTool: string; messageCount: number }[];
  recentSessions: {
    sessionId: string;
    sourceTool: string;
    machineId: string;
    messageCount: number;
    lastMessageAt: string;
  }[];
  tokenTrend: {
    day: string;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  }[];
  costTrend: { day: string; cost: number }[];
}

function GrowthIndicator({ value }: { value: number }) {
  if (value === 0) return null;
  const isPositive = value > 0;

  return (
    <span className={`flex items-center text-xs ${isPositive ? 'text-emerald-500' : 'text-red-500'}`}>
      {isPositive ? <TrendingUp className="mr-0.5 h-3 w-3" /> : <TrendingDown className="mr-0.5 h-3 w-3" />}
      {isPositive ? '+' : ''}
      {value}%
    </span>
  );
}

export default function DashboardPage() {
  const { t, locale } = useI18n();
  const [data, setData] = React.useState<DashboardData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [range, setRange] = React.useState<TimeRangeValue>(() => getDefaultRange(30));

  const fetchDashboard = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard/stats?from=${range.from}&to=${range.to}`);
      if (!res.ok) throw new Error('Failed to get dashboard data');
      const json = await res.json();
      setData(json.data);
      console.debug('[Dashboard] Data loading complete');
    } catch (error) {
      toast.error(t('dashboard.toast.loadFailed'));
      console.error('[Dashboard] Request failed:', error);
    } finally {
      setLoading(false);
    }
  }, [range, t]);

  React.useEffect(() => {
    fetchDashboard();
  }, [fetchDashboard]);

  const toolDistributionData = React.useMemo(() => {
    if (!data?.toolDistribution) return [];
    return data.toolDistribution.map((item, index) => ({
      sourceTool: item.sourceTool,
      label: getToolLabel(item.sourceTool),
      messageCount: item.messageCount,
      fill: CHART_COLORS[index % CHART_COLORS.length],
    }));
  }, [data?.toolDistribution]);

  const topTools = React.useMemo(() => toolDistributionData.slice(0, 8), [toolDistributionData]);
  const formatDayLabel = React.useCallback((value: string) => value.slice(5), []);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">{t('dashboard.title')}</h1>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-28" />)}
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Skeleton className="h-80 lg:col-span-2" />
          <Skeleton className="h-80" />
        </div>
        <Skeleton className="h-60" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('dashboard.title')}</h1>
        <TimeRangeSelector value={range} onChange={setRange} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('dashboard.activeDevices')}</CardTitle>
            <Monitor className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-mono text-2xl font-bold tabular-nums">{data?.activeDevices ?? 0}</div>
            <p className="mt-1 text-xs text-muted-foreground">{t('dashboard.activeDevices.detail', { total: data?.totalDevices ?? 0 })}</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('dashboard.totalCost')}</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-2xl font-bold tabular-nums">${(data?.totalCostUsd ?? 0).toFixed(2)}</span>
              <GrowthIndicator value={data?.growth.cost ?? 0} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('dashboard.sessionCount')}</CardTitle>
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-2xl font-bold tabular-nums">{(data?.sessionCount ?? 0).toLocaleString()}</span>
              <GrowthIndicator value={data?.growth.sessions ?? 0} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('dashboard.messageCount')}</CardTitle>
            <Hash className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-2xl font-bold tabular-nums">{(data?.messageCount ?? 0).toLocaleString()}</span>
              <GrowthIndicator value={data?.growth.messages ?? 0} />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('dashboard.tokens.total')}</CardTitle>
            <Cpu className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="font-mono text-xl font-bold tabular-nums">{formatTokenCount(data?.totalTokens ?? 0)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('dashboard.tokens.input')}</CardTitle>
            <ArrowDownToLine className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            <div className="font-mono text-xl font-bold tabular-nums">{formatTokenCount(data?.inputTokens ?? 0)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('dashboard.tokens.output')}</CardTitle>
            <ArrowUpFromLine className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="font-mono text-xl font-bold tabular-nums">{formatTokenCount(data?.outputTokens ?? 0)}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{t('dashboard.tokens.cache')}</CardTitle>
            <DatabaseZap className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="font-mono text-xl font-bold tabular-nums">{formatTokenCount((data?.cacheReadTokens ?? 0) + (data?.cacheWriteTokens ?? 0))}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('dashboard.chart.costTrend')}</CardTitle>
        </CardHeader>
        <CardContent>
          {(data?.costTrend ?? []).length > 0 ? (
            <ChartContainer config={COST_TREND_CHART_CONFIG} className="h-[280px] w-full">
              <LineChart data={data!.costTrend}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={formatDayLabel} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => `$${Number(value).toFixed(3)}`} />
                <ChartTooltip
                  content={(
                    <ChartTooltipContent
                      formatter={(value) => (
                        <div className="flex items-center justify-between gap-4 text-sm">
                          <span className="text-muted-foreground">{t('dashboard.legend.cost')}</span>
                          <span className="font-mono tabular-nums">${Number(value ?? 0).toFixed(4)}</span>
                        </div>
                      )}
                    />
                  )}
                />
                <Line type="monotone" dataKey="cost" stroke="var(--color-cost)" strokeWidth={2.5} dot={{ r: 2 }} activeDot={{ r: 4 }} />
              </LineChart>
            </ChartContainer>
          ) : (
            <div className="flex h-48 items-center justify-center text-muted-foreground">{t('common.noTrendData')}</div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">{t('dashboard.chart.tokenTrend')}</CardTitle>
          </CardHeader>
          <CardContent>
            {(data?.tokenTrend ?? []).length > 0 ? (
              <ChartContainer config={TOKEN_TREND_CHART_CONFIG} className="h-[280px] w-full">
                <ComposedChart data={data!.tokenTrend}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="day" tick={{ fontSize: 11 }} tickFormatter={formatDayLabel} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => formatTokenCount(Number(value))} />
                  <ChartTooltip
                    content={(
                      <ChartTooltipContent
                        formatter={(value, name) => (
                          <div className="flex items-center justify-between gap-4 text-sm">
                            <span className="text-muted-foreground">{String(name)}</span>
                            <span className="font-mono tabular-nums">{formatTokenCount(Number(value ?? 0))}</span>
                          </div>
                        )}
                      />
                    )}
                  />
                  <Bar dataKey="inputTokens" stackId="tokens" fill="var(--color-inputTokens)" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="outputTokens" stackId="tokens" fill="var(--color-outputTokens)" />
                  <Bar dataKey="cacheReadTokens" stackId="tokens" fill="var(--color-cacheReadTokens)" />
                  <Bar dataKey="cacheWriteTokens" stackId="tokens" fill="var(--color-cacheWriteTokens)" />
                  <Line type="monotone" dataKey="totalTokens" stroke="var(--color-totalTokens)" strokeWidth={2} dot={false} />
                  <ChartLegend content={<ChartLegendContent />} />
                </ComposedChart>
              </ChartContainer>
            ) : (
              <div className="flex h-48 items-center justify-center text-muted-foreground">{t('common.noTrendData')}</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('dashboard.chart.toolDistribution')}</CardTitle>
          </CardHeader>
          <CardContent>
            {topTools.length > 0 ? (
              <>
                <ChartContainer config={TOOL_DISTRIBUTION_CHART_CONFIG} className="h-[250px] w-full">
                  <BarChart data={topTools} layout="vertical" margin={{ left: 8, right: 12 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" tick={{ fontSize: 11 }} />
                    <YAxis
                      dataKey="label"
                      type="category"
                      width={86}
                      tick={{ fontSize: 11 }}
                      tickFormatter={(value: string) => (value.length > 11 ? `${value.slice(0, 11)}...` : value)}
                    />
                    <ChartTooltip
                      content={(
                        <ChartTooltipContent
                          formatter={(value, name, item) => (
                            <div className="flex items-center justify-between gap-4 text-sm">
                              <span className="text-muted-foreground">
                                {getToolLabel(String(item?.payload?.sourceTool ?? name ?? ''))}
                              </span>
                              <span className="font-mono tabular-nums">{Number(value ?? 0).toLocaleString()}</span>
                            </div>
                          )}
                        />
                      )}
                    />
                    <Bar dataKey="messageCount" radius={[0, 6, 6, 0]}>
                      {topTools.map((entry) => (
                        <Cell key={entry.sourceTool} fill={entry.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ChartContainer>

                <div className="mt-3 space-y-1.5">
                  {topTools.map((entry) => (
                    <div key={entry.sourceTool} className="flex items-center justify-between text-xs">
                      <span className="inline-flex items-center gap-2 text-muted-foreground">
                        <ToolLogo tool={entry.sourceTool} size={16} />
                        {entry.label}
                      </span>
                      <span className="font-mono tabular-nums">{entry.messageCount.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex h-48 items-center justify-center text-muted-foreground">{t('dashboard.empty.noToolData')}</div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">{t('dashboard.chart.recentSessions')}</CardTitle>
          <Link href="/sessions">
            <Button variant="ghost" size="sm" className="text-xs">
              {t('dashboard.chart.seeAll')} <ArrowRight className="ml-1 h-3 w-3" />
            </Button>
          </Link>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {(data?.recentSessions ?? []).length > 0 ? (
              data!.recentSessions.map((session) => {
                const toolColor = TOOL_COLORS[session.sourceTool];
                return (
                  <Link
                    key={session.sessionId}
                    href={`/sessions/${encodeURIComponent(session.sessionId)}`}
                    className="flex items-center justify-between rounded-md p-3 transition-colors hover:bg-accent"
                  >
                    <div className="flex items-center gap-3">
                      <Badge variant="secondary" className={toolColor?.text}>
                        <ToolLogo tool={session.sourceTool} size={16} />
                        {getToolLabel(session.sourceTool)}
                      </Badge>
                      <span className="max-w-[200px] truncate font-mono text-sm">{session.sessionId.slice(0, 16)}...</span>
                      <span className="text-xs text-muted-foreground">{t('sessions.messageCount', { count: session.messageCount })}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(session.lastMessageAt), { addSuffix: true, locale: dateFnsLocale(locale) })}
                    </span>
                  </Link>
                );
              })
            ) : (
              <div className="py-8 text-center text-muted-foreground">{t('dashboard.empty.noActiveSessions')}</div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
