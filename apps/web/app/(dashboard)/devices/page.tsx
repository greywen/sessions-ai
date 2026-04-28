'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Search, Filter, CheckCircle, XCircle, MoreHorizontal } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { TOOL_COLORS } from '@session-vault/shared';
import { formatDistanceToNow } from 'date-fns';
import { useI18n } from '@/lib/i18n/provider';
import { dateFnsLocale } from '@/lib/i18n/date-locale';

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

interface DevicesResponse {
  data: Device[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  statusCounts: Record<string, number>;
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'destructive'> = {
  active: 'default',
  pending: 'secondary',
  disabled: 'destructive',
};

export default function DevicesPage() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [devices, setDevices] = React.useState<Device[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [statusCounts, setStatusCounts] = React.useState<Record<string, number>>({});
  const [pagination, setPagination] = React.useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [statusFilter, setStatusFilter] = React.useState<string>('all');
  const [toolFilter, setToolFilter] = React.useState<string>('all');
  const [search, setSearch] = React.useState('');
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [confirmAction, setConfirmAction] = React.useState<{ device: Device; action: string } | null>(null);
  const [actionSubmitting, setActionSubmitting] = React.useState(false);
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

      console.debug('[Devices list] Query complete:', { total: json.pagination.total, page: json.pagination.page });
    } catch (error) {
      toast.error(t('devices.toast.loadFailed'));
      console.error('[Devices list] Request failed:', error);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, toolFilter, search, t]);

  React.useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  // S7.3: 30 Seconds Polling Refresh Device Online Status
  React.useEffect(() => {
    const interval = setInterval(() => {
      fetchDevices(pagination.page);
      console.debug('[Devices list] Refresh online status regularly');
    }, 30_000);
    return () => clearInterval(interval);
  }, [fetchDevices, pagination.page]);

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
    } catch { toast.error(t('common.operationFailed')); }
  };

  // S4.2: Take action after confirming the pop-up
  const handleConfirmedAction = async () => {
    if (!confirmAction) return;
    setActionSubmitting(true);
    await handleAction(confirmAction.device.id, confirmAction.action);
    setActionSubmitting(false);
    setConfirmAction(null);
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

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t('devices.title')}</h1>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder={t('devices.searchPlaceholder')} className="pl-8" value={search} onChange={(e) => handleSearchChange(e.target.value)} />
        </div>
        <Select value={toolFilter} onValueChange={setToolFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder={t('sessions.filter.tool')} /></SelectTrigger>
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

      {/* Status Tab */}
      <Tabs value={statusFilter} onValueChange={setStatusFilter}>
        <TabsList>
          <TabsTrigger value="all">{t('devices.tabs.all', { count: (statusCounts.pending ?? 0) + (statusCounts.active ?? 0) + (statusCounts.disabled ?? 0) })}</TabsTrigger>
          <TabsTrigger value="pending">{t('devices.tabs.pending', { count: statusCounts.pending ?? 0 })}</TabsTrigger>
          <TabsTrigger value="active">{t('devices.tabs.active', { count: statusCounts.active ?? 0 })}</TabsTrigger>
          <TabsTrigger value="disabled">{t('devices.tabs.disabled', { count: statusCounts.disabled ?? 0 })}</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Table Filter / Skeleton Screen / Empty Status */}
      {loading ? (
        <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => (<Skeleton key={i} className="h-12 w-full" />))}</div>
      ) : devices.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <Filter className="h-12 w-12 mb-4 opacity-50" />
          <p className="text-lg font-medium">{t('devices.empty.title')}</p>
          <p className="text-sm">{t('devices.empty.subtitle')}</p>
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[40px]"><Checkbox checked={allSelected} onCheckedChange={toggleAll} /></TableHead>
                <TableHead>{t('devices.col.name')}</TableHead>
                <TableHead>{t('devices.col.fingerprint')}</TableHead>
                <TableHead>{t('devices.col.user')}</TableHead>
                <TableHead>{t('devices.col.status')}</TableHead>
                <TableHead>{t('devices.col.lastSeen')}</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.map((device) => {
                const statusVariant = STATUS_VARIANT[device.status] ?? 'secondary' as const;
                const statusLabel = device.status === 'active'
                  ? t('devices.status.active')
                  : device.status === 'pending'
                    ? t('devices.status.pending')
                    : device.status === 'disabled'
                      ? t('devices.status.disabled')
                      : device.status;
                return (
                  <TableRow key={device.id} className="cursor-pointer" onClick={() => router.push(`/devices/${device.id}`)}>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={selectedIds.has(device.id)} onCheckedChange={() => toggleOne(device.id)} />
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${isOnline(device.lastSeenAt) ? 'bg-emerald-500' : 'bg-gray-400'}`} />
                        {device.displayName || device.osUsername || t('common.untitled')}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{device.fingerprint.substring(0, 8)}...</TableCell>
                    <TableCell>{device.ownerName || device.ownerEmail || t('common.notAvailable')}</TableCell>
                    <TableCell><Badge variant={statusVariant}>{statusLabel}</Badge></TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {device.lastSeenAt ? formatDistanceToNow(new Date(device.lastSeenAt), { addSuffix: true, locale: dateFnsLocale(locale) }) : t('devices.neverOnline')}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          {device.status === 'pending' && <DropdownMenuItem onClick={() => requestAction(device, 'approve')}><CheckCircle className="mr-2 h-4 w-4 text-emerald-500" />{t('devices.action.approve')}</DropdownMenuItem>}
                          {device.status === 'active' && <DropdownMenuItem onClick={() => requestAction(device, 'disable')}><XCircle className="mr-2 h-4 w-4 text-red-500" />{t('devices.action.disable')}</DropdownMenuItem>}
                          {device.status === 'disabled' && <DropdownMenuItem onClick={() => requestAction(device, 'enable')}><CheckCircle className="mr-2 h-4 w-4 text-emerald-500" />{t('devices.action.enable')}</DropdownMenuItem>}
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => router.push(`/devices/${device.id}`)}>{t('devices.action.viewMore')}</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {/* Bulk Actions Bar */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-3 rounded-lg border p-3 bg-muted/50">
              <span className="text-sm text-muted-foreground">{t('devices.bulk.selected', { count: selectedIds.size })}</span>
              <Button size="sm" onClick={() => handleBatchAction('approve')}>{t('devices.bulk.approve')}</Button>
              <Button size="sm" variant="destructive" onClick={() => handleBatchAction('disable')}>{t('devices.bulk.disable')}</Button>
            </div>
          )}

          {/* Pagination */}
          <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">{t('devices.pagination.summary', { total: pagination.total, page: pagination.page, totalPages: pagination.totalPages })}</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={pagination.page <= 1} onClick={() => fetchDevices(pagination.page - 1)}>{t('common.previous')}</Button>
              <Button variant="outline" size="sm" disabled={pagination.page >= pagination.totalPages} onClick={() => fetchDevices(pagination.page + 1)}>{t('common.next')}</Button>
            </div>
          </div>
        </>
      )}

      {/* S4.2: Operational Qualification Dialog */}
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
