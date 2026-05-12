'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Monitor, Clock, Shield, Ban, CheckCircle, Save, Loader2, Plus, Copy, History, Search, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDistanceToNow, format } from 'date-fns';
import { ToolLogo, getToolLabel } from '@/components/branding/ai-logo';
import { JsonEditor } from '@/components/json-editor';
import { useI18n } from '@/lib/i18n/provider';
import { dateFnsLocale } from '@/lib/i18n/date-locale';

interface DeviceDetail {
  id: string;
  fingerprint: string;
  osUsername: string | null;
  displayName: string | null;
  osInfo: { os?: string; version?: string; arch?: string; hostname?: string } | null;
  authKey: string;
  status: string;
  agentVersion: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  recentSessions: Array<{
    sessionId: string;
    sourceTool: string;
    messageCount: number;
    firstMessageAt: string;
    lastMessageAt: string;
  }>;
  stats: {
    totalSessions: number;
    totalMessages: number;
    monthCostUsd: string;
    totalTokens: number;
  };
}

// ==================== Configuration management related types and constants ====================

interface DeviceConfig {
  configId: string;
  name: string;
  configType: string;
  configPayload: Record<string, unknown>;
  filePath: string | null;
  version: number;
  pushStatus: string;
  ackedAt: string | null;
  pushedAt: string | null;
  errorMessage: string | null;
  pushedByName: string | null;
}

// Agent Individual Local Configuration Escalated
interface LocalConfigReport {
  path: string;
  content: Record<string, unknown> | null;
  exists: boolean;
  readAt: string;
  error?: string;
}

// Agent All local configurations escalated { configType -> LocalConfigReport }
type LocalConfigs = Record<string, LocalConfigReport>;

// Push History
interface PushHistoryItem {
  pushLogId: string;
  configType: string;
  configName: string;
  configPayload: Record<string, unknown>;
  filePath: string | null;
  status: string;
  pushedAt: string | null;
  ackedAt: string | null;
  errorMessage: string | null;
  pushedByName: string | null;
  createdAt: string;
}

// The configuration template
interface ConfigTemplateItem {
  id: string;
  name: string;
  configType: string;
  configPayload: Record<string, unknown>;
}

// Customize Configuration Tab
interface CustomTab {
  key: string;
  label: string;
  configType: 'custom';
  filePath: string;
}

// Supported default configuration types
const CONFIG_TYPE_TABS = [
  { value: 'claude_code', label: 'Claude Code' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'gemini_cli', label: 'Gemini CLI' },
] as const;

// Default file paths by type
const DEFAULT_FILE_PATHS: Record<string, string> = {
  claude_code: '~/.claude/settings.local.json',
  opencode: '~/.config/opencode/opencode.json',
  openclaw: '~/.openclaw/openclaw.json',
  gemini_cli: '~/.gemini/settings.json',
  codex: '~/.codex/config.toml',
};

// Default templates by type
const CONFIG_TEMPLATES: Record<string, Record<string, unknown>> = {
  claude_code: {
    permissions: {
      deny: ['Bash(rm -rf *)'],
    },
  },
  opencode: {
    provider: {
      default: 'anthropic',
    },
  },
  openclaw: {},
  gemini_cli: {},
  custom: {},
};

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive'> = {
  active: 'default',
  pending: 'secondary',
  disabled: 'destructive',
};

export default function DeviceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [device, setDevice] = React.useState<DeviceDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const resolvedParams = React.use(params);

  // Configuration Management Status
  const [deviceConfigs, setDeviceConfigs] = React.useState<DeviceConfig[]>([]);
  const [localConfigs, setLocalConfigs] = React.useState<LocalConfigs | null>(null);
  const [configEditors, setConfigEditors] = React.useState<Record<string, string>>({});
  const [configSaving, setConfigSaving] = React.useState<Record<string, boolean>>({});
  const [configLoading, setConfigLoading] = React.useState(false);
  // File path editing
  const [configFilePaths, setConfigFilePaths] = React.useState<Record<string, string>>({});
  // Push History
  const [pushHistory, setPushHistory] = React.useState<PushHistoryItem[]>([]);
  // Template Selection
  const [templates, setTemplates] = React.useState<ConfigTemplateItem[]>([]);
  // Search Templates
  const [templateSearch, setTemplateSearch] = React.useState<Record<string, string>>({});
  // Customizable Tab
  const [customTabs, setCustomTabs] = React.useState<CustomTab[]>([]);
  const [customDialogOpen, setCustomDialogOpen] = React.useState(false);
  const [customName, setCustomName] = React.useState('');
  const [customFilePath, setCustomFilePath] = React.useState('');
  const [customReading, setCustomReading] = React.useState(false);
  const [customReadContent, setCustomReadContent] = React.useState<string | null>(null);
  // Configure Acquisition Status
  const [configReading, setConfigReading] = React.useState<Record<string, boolean>>({});

  const fetchDevice = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/devices/${resolvedParams.id}`);
      if (!res.ok) throw new Error('Failed to get device details');
      const json = await res.json();
      setDevice(json.data);
    } catch (error) {
      toast.error(t('devices.detail.toast.loadFailed'));
      console.error('[Equipment Details] Request failed:', error);
    } finally {
      setLoading(false);
    }
  }, [resolvedParams.id, t]);

  // Get the current configuration of the device
  const fetchDeviceConfigs = React.useCallback(async () => {
    setConfigLoading(true);
    try {
      const res = await fetch(`/api/devices/${resolvedParams.id}/configs`);
      if (!res.ok) throw new Error();
      const json = await res.json();
      const configs: DeviceConfig[] = json.data ?? [];
      const agentLocalConfigs: LocalConfigs | null = json.localConfigs ?? null;
      const historyData: PushHistoryItem[] = json.history ?? [];
      setDeviceConfigs(configs);
      setLocalConfigs(agentLocalConfigs);
      setPushHistory(historyData);

      // Initialize editor content and file path
      const editors: Record<string, string> = {};
      const paths: Record<string, string> = {};
      for (const tab of CONFIG_TYPE_TABS) {
        const local = agentLocalConfigs?.[tab.value];
        const existing = configs.find((c) => c.configType === tab.value);

        if (local?.content) {
          // Agent Reported local document content
          editors[tab.value] = JSON.stringify(local.content, null, 2);
        } else if (existing) {
          // Pushed configurations
          editors[tab.value] = JSON.stringify(existing.configPayload, null, 2);
        } else {
          // Default template
          editors[tab.value] = JSON.stringify(CONFIG_TEMPLATES[tab.value] ?? {}, null, 2);
        }
        // File path preferred Agent Escalated,Second, use the last push,Last Use Default
        paths[tab.value] = local?.path || existing?.filePath || DEFAULT_FILE_PATHS[tab.value] || '';
      }

      // Initialize customization Tab(From Existing custom Type Configuration Recovery)
      const customConfigs = configs.filter((c) => c.configType === 'custom');
      const restoredCustomTabs: CustomTab[] = customConfigs.map((c, i) => ({
        key: `custom_${i}_${c.configId}`,
        label: c.name || 'Customize Configuration',
        configType: 'custom' as const,
        filePath: c.filePath || '',
      }));
      if (restoredCustomTabs.length > 0) {
        setCustomTabs(restoredCustomTabs);
        for (const ct of restoredCustomTabs) {
          const existing = customConfigs.find((c) => c.name === ct.label);
          if (existing) {
            editors[ct.key] = JSON.stringify(existing.configPayload, null, 2);
            paths[ct.key] = ct.filePath;
          }
        }
      }

      setConfigEditors(editors);
      setConfigFilePaths(paths);
    } catch {
      console.error('[Device Configuration] Load failed');
    } finally {
      setConfigLoading(false);
    }
  }, [resolvedParams.id]);

  // Get a list of configuration templates
  const fetchTemplates = React.useCallback(async () => {
    try {
      const res = await fetch('/api/configs');
      if (res.ok) {
        const json = await res.json();
        setTemplates(Array.isArray(json.data) ? json.data : []);
      }
    } catch { /* Non-critical */ }
  }, []);

  // Polling Profile Read Result(at most 30 Detik)
  const pollConfigReadResult = async (requestId: string): Promise<{ content: unknown; error?: string } | null> => {
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await fetch(`/api/devices/${resolvedParams.id}/config-read?requestId=${requestId}`);
        if (!res.ok) continue;
        const json = await res.json();
        const data = json.data;
        if (data.status === 'completed') {
          return { content: data.content };
        }
        if (data.status === 'failed') {
          return { content: null, error: data.error || 'Reading unsuccessful' };
        }
        // pending, Continue polling
      } catch { /* CONTINUE */ }
    }
    return { content: null, error: t('devices.detail.toast.readTimeout') };
  };

  // Get profile from device(Read on demand)
  const handleReadConfig = async (tabKey: string) => {
    const filePath = configFilePaths[tabKey];
    if (!filePath) {
      toast.error(t('devices.detail.toast.fillPath'));
      return;
    }

    setConfigReading((prev) => ({ ...prev, [tabKey]: true }));
    try {
      // Create Read Request
      const res = await fetch(`/api/devices/${resolvedParams.id}/config-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || t('devices.detail.toast.createReadFailed'));
        return;
      }
      const { data } = await res.json();
      toast.info(t('devices.detail.toast.readingFromDevice'));

      // Poll Results
      const result = await pollConfigReadResult(data.requestId);
      if (!result) {
        toast.error(t('devices.detail.toast.readTimeout'));
        return;
      }
      if (result.error) {
        toast.error(result.error);
        return;
      }
      // Berhasil:Update Editor
      const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content, null, 2);
      setConfigEditors((prev) => ({ ...prev, [tabKey]: content }));
      toast.success(t('devices.detail.toast.readSuccess'));
    } catch {
      toast.error(t('devices.detail.toast.readFailed'));
    } finally {
      setConfigReading((prev) => ({ ...prev, [tabKey]: false }));
    }
  };

  // Save and push configuration to device
  const handleConfigSave = async (tabKey: string, configType: string, configName?: string) => {
    const payloadStr = configEditors[tabKey];
    if (!payloadStr) return;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(payloadStr);
    } catch {
      toast.error(t('devices.detail.toast.invalidJson'));
      return;
    }

    setConfigSaving((prev) => ({ ...prev, [tabKey]: true }));
    try {
      const res = await fetch(`/api/devices/${resolvedParams.id}/configs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          configType,
          configName: configName || configType,
          filePath: configFilePaths[tabKey] || undefined,
          configPayload: payload,
        }),
      });
      const resData = await res.json();
      if (!res.ok) {
        toast.error(resData.error || t('devices.detail.toast.pushFailed'));
        return;
      }
      toast.success(t('devices.detail.toast.pushed'));

      // Optimistic update
      const now = new Date().toISOString();
      setDeviceConfigs((prev) => {
        const filtered = prev.filter((c) =>
          c.configType !== configType || (configType === 'custom' && c.name !== configName),
        );
        return [
          ...filtered,
          {
            configId: resData?.data?.configId ?? '',
            name: configName || configType,
            configType,
            configPayload: payload,
            filePath: configFilePaths[tabKey] || null,
            version: 0,
            pushStatus: 'pushed',
            ackedAt: null,
            pushedAt: now,
            errorMessage: null,
            pushedByName: null,
          },
        ];
      });
    } catch {
      toast.error(t('devices.detail.toast.pushFailed'));
    } finally {
      setConfigSaving((prev) => ({ ...prev, [tabKey]: false }));
    }
  };

  // Add custom configuration Tab(Authentication needs to be read from the device first)
  const handleAddCustomTab = async () => {
    if (!customName.trim()) {
      toast.error(t('devices.detail.toast.nameRequired'));
      return;
    }
    if (!customFilePath.trim()) {
      toast.error(t('devices.detail.toast.pathRequired'));
      return;
    }

    // Read profile validation from device
    setCustomReading(true);
    setCustomReadContent(null);
    try {
      const res = await fetch(`/api/devices/${resolvedParams.id}/config-read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: customFilePath.trim() }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || t('devices.detail.toast.createReadFailed'));
        return;
      }
      const { data } = await res.json();
      toast.info(t('devices.detail.toast.fetchingFromDevice'));

      const result = await pollConfigReadResult(data.requestId);
      if (!result || result.error) {
        toast.error(result?.error || t('devices.detail.toast.readPollFailed'));
        return;
      }

      // Reading succeeded,Buat Tab
      const key = `custom_${Date.now()}`;
      const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content, null, 2);
      const newTab: CustomTab = {
        key,
        label: customName.trim(),
        configType: 'custom',
        filePath: customFilePath.trim(),
      };
      setCustomTabs((prev) => [...prev, newTab]);
      setConfigEditors((prev) => ({ ...prev, [key]: content }));
      setConfigFilePaths((prev) => ({ ...prev, [key]: customFilePath.trim() }));
      setCustomDialogOpen(false);
      setCustomName('');
      setCustomFilePath('');
      setCustomReadContent(null);
      toast.success(t('devices.detail.toast.customAdded'));
    } catch {
      toast.error(t('devices.detail.toast.fetchConfigFailed'));
    } finally {
      setCustomReading(false);
    }
  };

  // Custom field deleted. Tab
  const handleRemoveCustomTab = (key: string) => {
    setCustomTabs((prev) => prev.filter((ct) => ct.key !== key));
    setConfigEditors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setConfigFilePaths((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  // Apply template to current editor
  const applyTemplate = (tabKey: string, template: ConfigTemplateItem) => {
    setConfigEditors((prev) => ({
      ...prev,
      [tabKey]: JSON.stringify(template.configPayload, null, 2),
    }));
    toast.success(t('devices.detail.toast.templateApplied', { name: template.name }));
  };

  React.useEffect(() => {
    fetchDevice();
    fetchDeviceConfigs();
    fetchTemplates();
  }, [fetchDevice, fetchDeviceConfigs, fetchTemplates]);

  const handleAction = async (action: string) => {
    try {
      const res = await fetch(`/api/devices/${resolvedParams.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || t('common.operationFailed'));
        return;
      }
      toast.success(t('devices.detail.toast.actionSucceeded'));
      fetchDevice();
    } catch { toast.error(t('common.operationFailed')); }
  };

  const isOnline = (lastSeenAt: string | null) => {
    if (!lastSeenAt) return false;
    return Date.now() - new Date(lastSeenAt).getTime() < 30_000;
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (!device) {
    return (
      <div className="flex flex-col items-center py-20">
        <p className="text-lg text-muted-foreground">{t('devices.detail.notFound')}</p>
        <Button variant="outline" className="mt-4" onClick={() => router.push('/devices')}>{t('devices.detail.back')}</Button>
      </div>
    );
  }

  const statusVariant = STATUS_VARIANT[device.status] ?? 'secondary' as const;
  const statusLabel = device.status === 'active'
    ? t('devices.status.active')
    : device.status === 'pending'
      ? t('devices.status.pending')
      : device.status === 'disabled'
        ? t('devices.status.disabled')
        : device.status;

  // Get a helper function that matches the template
  const getFilteredTemplates = (tabKey: string, configType: string) => {
    const searchQ = (templateSearch[tabKey] || '').toLowerCase();
    return templates
      .filter((t) => t.configType === configType || t.configType === 'custom')
      .filter((t) => !searchQ || t.name.toLowerCase().includes(searchQ));
  };

  // Rendering configuration edit area(Presets Tab and customization Tab Pooling)
  const renderConfigEditor = (
    tabKey: string,
    configType: string,
    label: string,
    isCustom: boolean,
  ) => {
    const existing = deviceConfigs.find((c) =>
      isCustom ? (c.configType === 'custom' && c.name === label) : c.configType === configType,
    );
    const local = isCustom ? null : localConfigs?.[configType];
    const isSaving = configSaving[tabKey] ?? false;
    const isReading = configReading[tabKey] ?? false;
    const tabHistory = pushHistory.filter((h) =>
      isCustom
        ? h.configType === 'custom' && h.configName === label
        : h.configType === configType,
    );
    const filteredTemplates = getFilteredTemplates(tabKey, configType);

    return (
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">{label}</CardTitle>
              {isCustom && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  onClick={() => handleRemoveCustomTab(tabKey)}
                  title={t('devices.detail.config.removeTip')}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <div className="flex items-center gap-3">
              {existing?.pushedAt && (
                <span className="text-xs text-muted-foreground">
                  {t('devices.detail.config.pushedAt', { time: format(new Date(existing.pushedAt), 'MM-dd HH:mm') })}
                  {existing.errorMessage && (
                    <span className="text-destructive ml-2">{existing.errorMessage}</span>
                  )}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={isReading || device.status !== 'active'}
                onClick={() => handleReadConfig(tabKey)}
                title={t('devices.detail.config.getConfigTitle')}
              >
                {isReading ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                )}
                {isReading ? t('devices.detail.config.getting') : t('devices.detail.config.getConfig')}
              </Button>
              <Button
                size="sm"
                disabled={isSaving || device.status !== 'active'}
                onClick={() => handleConfigSave(tabKey, configType, isCustom ? label : undefined)}
              >
                {isSaving ? (
                  <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-2 h-3.5 w-3.5" />
                )}
                {isSaving ? t('devices.detail.config.saving') : t('devices.detail.config.save')}
              </Button>
            </div>
          </div>
          {/* FilePath(Can Edit)+ Acquisition Time */}
          <div className="flex items-center gap-2 mt-2">
            <span className="text-xs text-muted-foreground shrink-0">{t('devices.detail.config.fileLabel')}</span>
            <Input
              value={configFilePaths[tabKey] || ''}
              onChange={(e) =>
                setConfigFilePaths((prev) => ({ ...prev, [tabKey]: e.target.value }))
              }
              className="h-7 text-xs font-mono flex-1"
              placeholder={DEFAULT_FILE_PATHS[configType] || ''}
            />
            {local?.readAt && (
              <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                {t('devices.detail.config.readAt', { time: new Date(local.readAt).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US') })}
              </span>
            )}
          </div>
          {/* Template Selection(Searchable) */}
          {templates.length > 0 && (
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xs text-muted-foreground shrink-0">{t('devices.detail.config.templateLabel')}</span>
              <Select
                onValueChange={(templateId) => {
                  const tpl = templates.find((t) => t.id === templateId);
                  if (tpl) applyTemplate(tabKey, tpl);
                }}
              >
                <SelectTrigger className="h-7 text-xs flex-1">
                  <SelectValue placeholder={t('devices.detail.config.templatePlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  <div className="px-2 pb-2">
                    <Input
                      placeholder={t('devices.detail.config.templateSearch')}
                      value={templateSearch[tabKey] || ''}
                      onChange={(e) =>
                        setTemplateSearch((prev) => ({ ...prev, [tabKey]: e.target.value }))
                      }
                      className="h-7 text-xs"
                    />
                  </div>
                  {filteredTemplates.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">{t('devices.detail.config.templateEmpty')}</div>
                  ) : (
                    filteredTemplates.map((tpl) => (
                      <SelectItem key={tpl.id} value={tpl.id}>
                        {tpl.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <JsonEditor
            value={configEditors[tabKey] ?? '{}'}
            onChange={(v) =>
              setConfigEditors((prev) => ({ ...prev, [tabKey]: v }))
            }
            height="400px"
            readOnly={device.status !== 'active'}
          />
          {device.status !== 'active' && (
            <p className="text-xs text-muted-foreground">
              {t('devices.detail.config.notActive')}
            </p>
          )}
          {local?.content && (
            <p className="text-xs text-muted-foreground">
              {t('devices.detail.config.showLocal')}
            </p>
          )}
          {local && !local.exists && (
            <p className="text-xs text-muted-foreground">
              {existing
                ? t('devices.detail.config.fileNotExistWithRecent')
                : t('devices.detail.config.fileNotExistDefault')}
            </p>
          )}
          {local?.error && (
            <p className="text-xs text-destructive">{t('devices.detail.config.readError', { error: local.error })}</p>
          )}

          {/* Push History */}
          {tabHistory.length > 0 && (
            <div className="border rounded-lg p-3 space-y-2">
              <h4 className="text-sm font-medium flex items-center gap-1.5">
                <History className="h-3.5 w-3.5" />
                {t('devices.detail.config.historyTitle')}
              </h4>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {tabHistory.map((h) => (
                  <div
                    key={h.pushLogId}
                    className="flex items-center justify-between text-xs py-1.5 px-2 rounded hover:bg-muted"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge
                        variant={h.status === 'acked' ? 'default' : h.status === 'failed' ? 'destructive' : 'secondary'}
                        className="text-[10px] px-1.5 py-0 shrink-0"
                      >
                        {h.status === 'acked'
                          ? t('devices.detail.config.historyStatus.acked')
                          : h.status === 'failed'
                            ? t('devices.detail.config.historyStatus.failed')
                            : t('devices.detail.config.historyStatus.pending')}
                      </Badge>
                      <span className="text-muted-foreground truncate">
                        {h.pushedAt ? format(new Date(h.pushedAt), 'yyyy-MM-dd HH:mm') : '--'}
                      </span>
                      {h.pushedByName && (
                        <span className="text-muted-foreground">· {h.pushedByName}</span>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0"
                      onClick={() => {
                        navigator.clipboard.writeText(JSON.stringify(h.configPayload, null, 2));
                        toast.success(t('devices.detail.toast.historyCopied'));
                      }}
                      title={t('devices.detail.config.copyHistory')}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      {/* Heading */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => router.push('/devices')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{device.displayName || device.osUsername || t('devices.detail.unnamed')}</h1>
            <Badge variant={statusVariant}>{statusLabel}</Badge>
            <span className={`h-2.5 w-2.5 rounded-full ${isOnline(device.lastSeenAt) ? 'bg-emerald-500' : 'bg-gray-400'}`} />
          </div>
          <p className="text-sm text-muted-foreground font-mono">{device.fingerprint}</p>
        </div>
        <div className="flex gap-2">
          {device.status === 'pending' && (
            <Button onClick={() => handleAction('approve')}>
              <CheckCircle className="mr-2 h-4 w-4" />{t('devices.action.approve')}
            </Button>
          )}
          {device.status === 'active' && (
            <Button variant="destructive" onClick={() => handleAction('disable')}>
              <Ban className="mr-2 h-4 w-4" />{t('devices.action.disable')}
            </Button>
          )}
          {device.status === 'disabled' && (
            <Button onClick={() => handleAction('enable')}>
              <CheckCircle className="mr-2 h-4 w-4" />{t('devices.action.enable')}
            </Button>
          )}
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">{t('devices.detail.tabs.overview')}</TabsTrigger>
          <TabsTrigger value="configs">{t('devices.detail.tabs.configs')}</TabsTrigger>
        </TabsList>

        {/* ==================== Overview 3 Tab ==================== */}
        <TabsContent value="overview" className="space-y-6">

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Basic Information */}
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="flex items-center gap-2"><Monitor className="h-4 w-4" />{t('devices.detail.info.title')}</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground">{t('devices.detail.info.os')}</dt>
                <dd>{device.osInfo?.os ?? '--'} {device.osInfo?.version ?? ''}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('devices.detail.info.arch')}</dt>
                <dd>{device.osInfo?.arch ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('devices.detail.info.hostname')}</dt>
                <dd>{device.osInfo?.hostname ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('devices.detail.info.agentVersion')}</dt>
                <dd className="font-mono">{device.agentVersion ?? '--'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('devices.detail.info.registeredAt')}</dt>
                <dd>{format(new Date(device.createdAt), 'yyyy-MM-dd HH:mm:ss')}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t('devices.detail.info.lastActive')}</dt>
                <dd>{device.lastSeenAt ? formatDistanceToNow(new Date(device.lastSeenAt), { addSuffix: true, locale: dateFnsLocale(locale) }) : t('devices.neverOnline')}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {/* Statistics */}
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Shield className="h-4 w-4" />{t('devices.detail.stats.title')}</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('devices.detail.stats.totalSessions')}</dt>
                  <dd className="font-mono tabular-nums">{device.stats.totalSessions}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('devices.detail.stats.totalMessages')}</dt>
                  <dd className="font-mono tabular-nums">{device.stats.totalMessages}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('devices.detail.stats.monthCost')}</dt>
                  <dd className="font-mono tabular-nums" title={t('cost.approximate.tooltip')}>~${Number(device.stats.monthCostUsd).toFixed(2)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t('devices.detail.stats.totalTokens')}</dt>
                  <dd className="font-mono tabular-nums">{device.stats.totalTokens.toLocaleString()} {t('block.usage.unit')}</dd>
                </div>
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Recent Sessions */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Clock className="h-4 w-4" />{t('devices.detail.recent.title')}</CardTitle></CardHeader>
        <CardContent>
          {device.recentSessions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">{t('devices.detail.recent.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('devices.detail.recent.col.sessionId')}</TableHead>
                  <TableHead>{t('devices.detail.recent.col.tool')}</TableHead>
                  <TableHead>{t('devices.detail.recent.col.messageCount')}</TableHead>
                  <TableHead>{t('devices.detail.recent.col.firstAt')}</TableHead>
                  <TableHead>{t('devices.detail.recent.col.lastAt')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {device.recentSessions.map((s) => (
                  <TableRow key={s.sessionId} className="cursor-pointer" onClick={() => router.push(`/sessions/${s.sessionId}`)}>
                    <TableCell className="font-mono text-xs">{s.sessionId.substring(0, 16)}...</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        <ToolLogo tool={s.sourceTool} size={16} />
                        {getToolLabel(s.sourceTool)}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono tabular-nums">{s.messageCount}</TableCell>
                    <TableCell className="text-xs">{format(new Date(s.firstMessageAt), 'MM-dd HH:mm')}</TableCell>
                    <TableCell className="text-xs">{formatDistanceToNow(new Date(s.lastMessageAt), { addSuffix: true, locale: dateFnsLocale(locale) })}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

        </TabsContent>

        {/* ==================== Configuration Management Tab ==================== */}
        <TabsContent value="configs">
          {configLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-32" />
              ))}
            </div>
          ) : (
            <Tabs defaultValue="claude_code" className="space-y-4">
              <TabsList>
                {CONFIG_TYPE_TABS.map((tab) => (
                  <TabsTrigger key={tab.value} value={tab.value}>
                    {tab.label}
                  </TabsTrigger>
                ))}
                {customTabs.map((ct) => (
                  <TabsTrigger key={ct.key} value={ct.key}>
                    {ct.label}
                  </TabsTrigger>
                ))}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 ml-1"
                  onClick={() => setCustomDialogOpen(true)}
                  title={t('devices.detail.custom.add')}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </TabsList>

              {/* Preset Configs Tab Contents */}
              {CONFIG_TYPE_TABS.map((tab) => (
                <TabsContent key={tab.value} value={tab.value}>
                  {renderConfigEditor(tab.value, tab.value, `${tab.label} ${t('devices.detail.config.suffix')}`, false)}
                </TabsContent>
              ))}

              {/* Customize Configuration Tab Contents */}
              {customTabs.map((ct) => (
                <TabsContent key={ct.key} value={ct.key}>
                  {renderConfigEditor(ct.key, 'custom', ct.label, true)}
                </TabsContent>
              ))}
            </Tabs>
          )}

          {/* Add custom configuration Dialog */}
          <Dialog open={customDialogOpen} onOpenChange={setCustomDialogOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('devices.detail.custom.title')}</DialogTitle>
                <DialogDescription>
                  {t('devices.detail.custom.desc')}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label>{t('devices.detail.custom.name')}</Label>
                  <Input
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder={t('devices.detail.custom.namePlaceholder')}
                  />
                </div>
                <div className="space-y-2">
                  <Label>{t('devices.detail.custom.path')}</Label>
                  <Input
                    value={customFilePath}
                    onChange={(e) => setCustomFilePath(e.target.value)}
                    placeholder={t('devices.detail.custom.pathPlaceholder')}
                    className="font-mono text-sm"
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCustomDialogOpen(false)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  onClick={handleAddCustomTab}
                  disabled={!customName.trim() || !customFilePath.trim() || customReading}
                >
                  {customReading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t('devices.detail.custom.fetching')}
                    </>
                  ) : (
                    t('devices.detail.custom.confirm')
                  )}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </TabsContent>
      </Tabs>
    </div>
  );
}
