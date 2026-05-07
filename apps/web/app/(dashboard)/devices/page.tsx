'use client';

import React from 'react';
import { toast } from 'sonner';
import { CheckCircle, Filter, MoreHorizontal, Save, Search, XCircle } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n/provider';
import { dateFnsLocale } from '@/lib/i18n/date-locale';
import { cn } from '@/lib/utils';
import { JsonEditor } from '@/components/json-editor';

interface Device {
  id: string;
  fingerprint: string;
  osUsername: string | null;
  displayName: string | null;
  osInfo: Record<string, string> | null;
  ownerId: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  status: string;
  agentVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DeviceDetail extends Device {
  stats: {
    totalSessions: number;
    totalMessages: number;
    monthCostUsd: string;
    totalTokens: number;
  };
}

type ConfigType = 'claude_code' | 'opencode' | 'openclaw' | 'gemini_cli';

interface DeviceConfigItem {
  configId: string;
  name: string;
  configType: ConfigType | 'custom';
  configPayload: Record<string, unknown>;
  filePath: string | null;
}

interface LocalConfigReport {
  path: string;
  content: Record<string, unknown> | null;
}

type LocalConfigs = Record<string, LocalConfigReport>;

interface DevicesResponse {
  data: Device[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  statusCounts: Record<string, number>;
}

interface DeviceConfigsResponse {
  data?: DeviceConfigItem[];
  localConfigs?: LocalConfigs | null;
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive'> = {
  active: 'default',
  pending: 'secondary',
  disabled: 'destructive',
};

const CONFIG_TABS: Array<{ value: ConfigType; label: string }> = [
  { value: 'claude_code', label: 'Claude Code' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'gemini_cli', label: 'Gemini CLI' },
];

const DEFAULT_FILE_PATHS: Record<ConfigType, string> = {
  claude_code: '~/.claude/settings.local.json',
  opencode: '~/.config/opencode/opencode.json',
  openclaw: '~/.openclaw/openclaw.json',
  gemini_cli: '~/.gemini/settings.json',
};

const DEFAULT_TEMPLATES: Record<ConfigType, Record<string, unknown>> = {
  claude_code: { permissions: { deny: ['Bash(rm -rf *)'] } },
  opencode: { provider: { default: 'anthropic' } },
  openclaw: {},
  gemini_cli: {},
};

export default function DevicesPage() {
  const { t, locale } = useI18n();
  const [devices, setDevices] = React.useState<Device[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = React.useState<string | null>(null);
  const [selectedDeviceDetail, setSelectedDeviceDetail] = React.useState<DeviceDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [statusCounts, setStatusCounts] = React.useState<Record<string, number>>({});
  const [pagination, setPagination] = React.useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [statusFilter, setStatusFilter] = React.useState<string>('all');
  const [toolFilter, setToolFilter] = React.useState<string>('all');
  const [search, setSearch] = React.useState('');
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [confirmAction, setConfirmAction] = React.useState<{ device: Device; action: string } | null>(null);
  const [actionSubmitting, setActionSubmitting] = React.useState(false);

  const [rightTab, setRightTab] = React.useState<'overview' | 'configs'>('overview');
  const [configLoading, setConfigLoading] = React.useState(false);
  const [activeConfigTab, setActiveConfigTab] = React.useState<ConfigType>('claude_code');
  const [configEditors, setConfigEditors] = React.useState<Record<string, string>>({});
  const [configFilePaths, setConfigFilePaths] = React.useState<Record<string, string>>({});
  const [configSaving, setConfigSaving] = React.useState<Record<string, boolean>>({});

  const searchTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchDevices = React.useCallback(async (page = 1) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', '20');
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (toolFilter !== 'all') params.set('sourceTool', toolFilter);
      if (search) params.set('search', search);

      const res = await fetch(`/api/devices?${params}`);
      if (!res.ok) throw new Error('Failed to get device list');
      const json: DevicesResponse = await res.json();

      setDevices(json.data);
      setPagination(json.pagination);
      setStatusCounts(json.statusCounts);
      setSelectedIds(new Set());
    } catch (error) {
      toast.error(t('devices.toast.loadFailed'));
      console.error('[Devices list] Request failed:', error);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, toolFilter, search, t]);

  const fetchDeviceDetail = React.useCallback(async (deviceId: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/devices/${deviceId}`);
      if (!res.ok) throw new Error('Failed to get device detail');
      const json = await res.json();
      setSelectedDeviceDetail(json.data ?? null);
    } catch (error) {
      setSelectedDeviceDetail(null);
      toast.error(t('devices.detail.toast.loadFailed'));
      console.error('[Devices page] Detail request failed:', error);
    } finally {
      setDetailLoading(false);
    }
  }, [t]);

  const fetchDeviceConfigs = React.useCallback(async (deviceId: string) => {
    setConfigLoading(true);
    try {
      const res = await fetch(`/api/devices/${deviceId}/configs`);
      if (!res.ok) throw new Error('Failed to get device configs');
      const json: DeviceConfigsResponse = await res.json();

      const configs = json.data ?? [];
      const localConfigs = json.localConfigs ?? null;
      const editors: Record<string, string> = {};
      const paths: Record<string, string> = {};

      for (const tab of CONFIG_TABS) {
        const local = localConfigs?.[tab.value];
        const existing = configs.find((c) => c.configType === tab.value);

        if (local?.content) {
          editors[tab.value] = JSON.stringify(local.content, null, 2);
        } else if (existing) {
          editors[tab.value] = JSON.stringify(existing.configPayload, null, 2);
        } else {
          editors[tab.value] = JSON.stringify(DEFAULT_TEMPLATES[tab.value], null, 2);
        }

        paths[tab.value] = local?.path || existing?.filePath || DEFAULT_FILE_PATHS[tab.value];
      }

      setConfigEditors(editors);
      setConfigFilePaths(paths);
    } catch (error) {
      toast.error(t('devices.detail.toast.loadFailed'));
      console.error('[Devices page] Config request failed:', error);
    } finally {
      setConfigLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  React.useEffect(() => {
    if (devices.length === 0) {
      setSelectedDeviceId(null);
      setSelectedDeviceDetail(null);
      return;
    }
    if (!selectedDeviceId || !devices.some((item) => item.id === selectedDeviceId)) {
      setSelectedDeviceId(devices[0].id);
    }
  }, [devices, selectedDeviceId]);

  React.useEffect(() => {
    if (!selectedDeviceId) return;
    fetchDeviceDetail(selectedDeviceId);
    fetchDeviceConfigs(selectedDeviceId);
  }, [selectedDeviceId, fetchDeviceDetail, fetchDeviceConfigs]);

  React.useEffect(() => {
    const interval = setInterval(() => {
      fetchDevices(pagination.page);
    }, 30_000);
    return () => clearInterval(interval);
  }, [fetchDevices, pagination.page]);

  const selectedDevice = React.useMemo(
    () => devices.find((item) => item.id === selectedDeviceId) ?? null,
    [devices, selectedDeviceId],
  );

  const panelDevice = selectedDeviceDetail ?? selectedDevice;

  const getStatusLabel = React.useCallback((status: string) => (
    status === 'active'
      ? t('devices.status.active')
      : status === 'pending'
        ? t('devices.status.pending')
        : status === 'disabled'
          ? t('devices.status.disabled')
          : status
  ), [t]);

  const handleSearchChange = (value: string) => {
    setSearch(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => fetchDevices(1), 300);
  };

  const handleBatchAction = async (action: 'approve' | 'disable') => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    let successCount = 0;
    for (const id of ids) {
      try {
        const res = await fetch(`/api/devices/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        if (res.ok) successCount++;
      } catch { /* Ignore individual failures */ }
    }
    toast.success(
      action === 'approve'
        ? t('devices.bulk.approveDone', { success: successCount, total: ids.length })
        : t('devices.bulk.disableDone', { success: successCount, total: ids.length }),
    );
    fetchDevices(pagination.page);
    if (selectedDeviceId) {
      fetchDeviceDetail(selectedDeviceId);
    }
  };

  const handleAction = async (id: string, action: string) => {
    try {
      const res = await fetch(`/api/devices/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || t('common.operationFailed'));
        return;
      }
      toast.success(t('common.operationSucceeded'));
      fetchDevices(pagination.page);
      if (id === selectedDeviceId) {
        fetchDeviceDetail(id);
      }
    } catch { toast.error(t('common.operationFailed')); }
  };

  const handleConfirmedAction = async () => {
    if (!confirmAction) return;
    setActionSubmitting(true);
    await handleAction(confirmAction.device.id, confirmAction.action);
    setActionSubmitting(false);
    setConfirmAction(null);
  };

  const handleSaveConfig = async (configType: ConfigType) => {
    if (!selectedDeviceId) return;
    const payloadStr = configEditors[configType] ?? '{}';
    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(payloadStr);
    } catch {
      toast.error(t('devices.detail.toast.invalidJson'));
      return;
    }

    setConfigSaving((prev) => ({ ...prev, [configType]: true }));
    try {
      const configName = `${panelDevice?.displayName || panelDevice?.osUsername || 'Device'} ${configType}`;
      const res = await fetch(`/api/devices/${selectedDeviceId}/configs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configType,
          configName,
          filePath: configFilePaths[configType] || undefined,
          configPayload: payload,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || t('devices.detail.toast.pushFailed'));
        return;
      }

      toast.success(t('devices.detail.toast.pushed'));
      fetchDeviceConfigs(selectedDeviceId);
    } catch {
      toast.error(t('devices.detail.toast.pushFailed'));
    } finally {
      setConfigSaving((prev) => ({ ...prev, [configType]: false }));
    }
  };

  const requestAction = (device: Device, action: string) => {
    setConfirmAction({ device, action });
  };

  const allSelected = devices.length > 0 && devices.every((d) => selectedIds.has(d.id));
  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(devices.map((d) => d.id)));
  };
  const toggleOne = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedIds(next);
  };

  const isOnline = (lastSeenAt: string | null) => {
    if (!lastSeenAt) return false;
    return Date.now() - new Date(lastSeenAt).getTime() < 30_000;
  };

  const renderConfigEditor = (configType: ConfigType) => {
    const canEdit = panelDevice?.status === 'active';
    const isSaving = !!configSaving[configType];
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Input
            value={configFilePaths[configType] ?? ''}
            onChange={(e) => setConfigFilePaths((prev) => ({ ...prev, [configType]: e.target.value }))}
            className="h-8 bg-background text-xs font-mono"
            placeholder={DEFAULT_FILE_PATHS[configType]}
          />
          <Button
            size="sm"
            onClick={() => handleSaveConfig(configType)}
            disabled={isSaving || !canEdit}
          >
            <Save className="mr-2 h-3.5 w-3.5" />
            {isSaving ? t('devices.detail.config.saving') : t('devices.detail.config.save')}
          </Button>
        </div>
        <JsonEditor
          value={configEditors[configType] ?? '{}'}
          onChange={(value) => setConfigEditors((prev) => ({ ...prev, [configType]: value }))}
          height="320px"
          readOnly={!canEdit}
        />
        {!canEdit && (
          <p className="text-xs text-muted-foreground">{t('devices.detail.config.notActive')}</p>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('devices.searchPlaceholder')}
            className="h-9 pl-8 bg-background"
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-9 w-[140px] bg-background"><SelectValue placeholder={t('devices.col.status')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('devices.tabs.all', { count: (statusCounts.pending ?? 0) + (statusCounts.active ?? 0) + (statusCounts.disabled ?? 0) })}</SelectItem>
            <SelectItem value="pending">{t('devices.tabs.pending', { count: statusCounts.pending ?? 0 })}</SelectItem>
            <SelectItem value="active">{t('devices.tabs.active', { count: statusCounts.active ?? 0 })}</SelectItem>
            <SelectItem value="disabled">{t('devices.tabs.disabled', { count: statusCounts.disabled ?? 0 })}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={toolFilter} onValueChange={setToolFilter}>
          <SelectTrigger className="h-9 w-[140px] bg-background"><SelectValue placeholder={t('sessions.filter.tool')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('sessions.filter.allTools')}</SelectItem>
            <SelectItem value="ClaudeCode">Claude Code</SelectItem>
            <SelectItem value="OpenCode">OpenCode</SelectItem>
            <SelectItem value="Cursor">Cursor</SelectItem>
            <SelectItem value="GeminiCli">Gemini CLI</SelectItem>
            <SelectItem value="Aider">Aider</SelectItem>
            <SelectItem value="GitHubCopilot">GitHub Copilot</SelectItem>
            <SelectItem value="Codex">Codex</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => (<Skeleton key={i} className="h-12 w-full" />))}</div>
      ) : devices.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Filter className="h-12 w-12 mb-4 opacity-50" />
          <p className="text-lg font-medium">{t('devices.empty.title')}</p>
          <p className="text-sm">{t('devices.empty.subtitle')}</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2.4fr)_minmax(360px,2fr)] lg:items-start">
          <div className="space-y-3">
            <div className="rounded-lg border border-border/70">
              <div className="max-h-[calc(100vh-320px)] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[40px]"><Checkbox checked={allSelected} onCheckedChange={toggleAll} /></TableHead>
                      <TableHead>{t('devices.col.name')}</TableHead>
                      <TableHead>{t('devices.col.user')}</TableHead>
                      <TableHead>{t('devices.col.status')}</TableHead>
                      <TableHead>{t('devices.col.lastSeen')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {devices.map((device) => {
                      const statusVariant = STATUS_VARIANT[device.status] ?? 'secondary' as const;
                      const selected = device.id === selectedDevice?.id;
                      return (
                        <TableRow
                          key={device.id}
                          className={cn('cursor-pointer', selected && 'bg-muted/35')}
                          onClick={() => setSelectedDeviceId(device.id)}
                        >
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <Checkbox checked={selectedIds.has(device.id)} onCheckedChange={() => toggleOne(device.id)} />
                          </TableCell>
                          <TableCell className="font-medium">
                            <div className="flex items-center gap-2">
                              <span className={`h-2 w-2 rounded-full ${isOnline(device.lastSeenAt) ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                              {device.displayName || device.osUsername || t('common.untitled')}
                            </div>
                          </TableCell>
                          <TableCell>{device.ownerName || device.ownerEmail || t('common.notAvailable')}</TableCell>
                          <TableCell><Badge variant={statusVariant}>{getStatusLabel(device.status)}</Badge></TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {device.lastSeenAt ? formatDistanceToNow(new Date(device.lastSeenAt), { addSuffix: true, locale: dateFnsLocale(locale) }) : t('devices.neverOnline')}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>

            {selectedIds.size > 0 && (
              <div className="flex items-center gap-3 rounded-lg border p-3 bg-muted/50">
                <span className="text-sm text-muted-foreground">{t('devices.bulk.selected', { count: selectedIds.size })}</span>
                <Button size="sm" onClick={() => handleBatchAction('approve')}>{t('devices.bulk.approve')}</Button>
                <Button size="sm" variant="destructive" onClick={() => handleBatchAction('disable')}>{t('devices.bulk.disable')}</Button>
              </div>
            )}

            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">{t('devices.pagination.summary', { total: pagination.total, page: pagination.page, totalPages: pagination.totalPages })}</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={pagination.page <= 1} onClick={() => fetchDevices(pagination.page - 1)}>{t('common.previous')}</Button>
                <Button variant="outline" size="sm" disabled={pagination.page >= pagination.totalPages} onClick={() => fetchDevices(pagination.page + 1)}>{t('common.next')}</Button>
              </div>
            </div>
          </div>

          <Card className="border-border/70 lg:sticky lg:top-[5.5rem] lg:max-h-[calc(100vh-6rem)] overflow-hidden">
            <CardContent className="py-4 h-full">
              {selectedDevice ? (
                <Tabs value={rightTab} onValueChange={(v) => setRightTab(v as 'overview' | 'configs')} className="flex h-full flex-col">
                  <TabsList className="grid h-9 w-full grid-cols-2">
                    <TabsTrigger value="overview">{t('devices.detail.tabs.overview')}</TabsTrigger>
                    <TabsTrigger value="configs">{t('devices.detail.tabs.configs')}</TabsTrigger>
                  </TabsList>

                  <TabsContent value="overview" className="mt-3 flex-1 overflow-y-auto space-y-4">
                    {detailLoading || !panelDevice ? (
                      <div className="space-y-3">
                        <Skeleton className="h-20 w-full" />
                        <Skeleton className="h-24 w-full" />
                      </div>
                    ) : (
                      <>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h2 className="truncate text-lg font-semibold">
                              {panelDevice.displayName || panelDevice.osUsername || t('common.untitled')}
                            </h2>
                            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{panelDevice.fingerprint}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`h-2.5 w-2.5 rounded-full ${isOnline(panelDevice.lastSeenAt) ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                            <Badge variant={STATUS_VARIANT[panelDevice.status] ?? 'secondary'}>
                              {getStatusLabel(panelDevice.status)}
                            </Badge>
                          </div>
                        </div>

                        <dl className="grid grid-cols-2 gap-3 text-xs sm:text-sm">
                          <div>
                            <dt className="text-muted-foreground">{t('devices.col.user')}</dt>
                            <dd>{panelDevice.ownerName || panelDevice.ownerEmail || t('common.notAvailable')}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">{t('devices.detail.info.agentVersion')}</dt>
                            <dd className="font-mono">{panelDevice.agentVersion ?? '--'}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">{t('devices.detail.stats.totalSessions')}</dt>
                            <dd>{selectedDeviceDetail?.stats.totalSessions ?? '--'}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">{t('devices.detail.stats.totalMessages')}</dt>
                            <dd>{selectedDeviceDetail?.stats.totalMessages ?? '--'}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">{t('devices.detail.stats.totalTokens')}</dt>
                            <dd>{selectedDeviceDetail?.stats.totalTokens?.toLocaleString?.() ?? '--'}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">{t('devices.detail.stats.monthCost')}</dt>
                            <dd title={t('cost.approximate.tooltip')}>~${Number(selectedDeviceDetail?.stats.monthCostUsd ?? 0).toFixed(2)}</dd>
                          </div>
                        </dl>

                        <div className="flex flex-wrap gap-2">
                          {panelDevice.status === 'pending' && (
                            <Button size="sm" onClick={() => requestAction(selectedDevice, 'approve')}>
                              <CheckCircle className="mr-2 h-4 w-4" />{t('devices.action.approve')}
                            </Button>
                          )}
                          {panelDevice.status === 'active' && (
                            <Button size="sm" variant="destructive" onClick={() => requestAction(selectedDevice, 'disable')}>
                              <XCircle className="mr-2 h-4 w-4" />{t('devices.action.disable')}
                            </Button>
                          )}
                          {panelDevice.status === 'disabled' && (
                            <Button size="sm" onClick={() => requestAction(selectedDevice, 'enable')}>
                              <CheckCircle className="mr-2 h-4 w-4" />{t('devices.action.enable')}
                            </Button>
                          )}
                        </div>
                      </>
                    )}
                  </TabsContent>

                  <TabsContent value="configs" className="mt-3 flex-1 overflow-y-auto">
                    {configLoading ? (
                      <div className="space-y-3">
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-64 w-full" />
                      </div>
                    ) : (
                      <Tabs value={activeConfigTab} onValueChange={(v) => setActiveConfigTab(v as ConfigType)} className="space-y-3">
                        <TabsList className="h-auto w-full flex-wrap justify-start gap-1 bg-transparent p-0">
                          {CONFIG_TABS.map((tab) => (
                            <TabsTrigger key={tab.value} value={tab.value} className="h-8 rounded-md border">
                              {tab.label}
                            </TabsTrigger>
                          ))}
                        </TabsList>
                        {CONFIG_TABS.map((tab) => (
                          <TabsContent key={tab.value} value={tab.value} className="mt-0">
                            {renderConfigEditor(tab.value)}
                          </TabsContent>
                        ))}
                      </Tabs>
                    )}
                  </TabsContent>
                </Tabs>
              ) : (
                <div className="py-10 text-center text-sm text-muted-foreground">{t('devices.empty.title')}</div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmAction?.action === 'approve' && t('devices.confirm.approve.title')}
              {confirmAction?.action === 'disable' && t('devices.confirm.disable.title')}
              {confirmAction?.action === 'enable' && t('devices.confirm.enable.title')}
            </DialogTitle>
            <DialogDescription>
              {confirmAction?.action === 'approve' && t('devices.confirm.approve.desc')}
              {confirmAction?.action === 'disable' && t('devices.confirm.disable.desc')}
              {confirmAction?.action === 'enable' && t('devices.confirm.enable.desc')}
            </DialogDescription>
          </DialogHeader>
          {confirmAction && (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">{t('devices.confirm.field.name')}</span><span className="font-medium">{confirmAction.device.displayName || confirmAction.device.osUsername || t('common.untitled')}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">{t('devices.confirm.field.fingerprint')}</span><span className="font-mono text-xs">{confirmAction.device.fingerprint}</span></div>
              {confirmAction.device.osInfo && (
                <div className="flex justify-between"><span className="text-muted-foreground">{t('devices.confirm.field.os')}</span><span>{confirmAction.device.osInfo.os ?? '--'} {confirmAction.device.osInfo.arch ?? ''}</span></div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)}>{t('common.cancel')}</Button>
            <Button
              variant={confirmAction?.action === 'disable' ? 'destructive' : 'default'}
              onClick={handleConfirmedAction}
              disabled={actionSubmitting}
            >
              {t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
