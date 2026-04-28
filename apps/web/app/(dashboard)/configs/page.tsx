'use client';

import React from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, FileJson, Copy, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { JsonEditor } from '@/components/json-editor';
import { useI18n } from '@/lib/i18n/provider';
import { format } from 'date-fns';
import { dateFnsLocale } from '@/lib/i18n/date-locale';

// ==================== Type definition ====================

interface ConfigTemplate {
  id: string;
  name: string;
  configType: string;
  configPayload: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// ==================== Constant ====================

const CONFIG_TYPE_VALUES = ['claude_code', 'opencode', 'openclaw', 'gemini_cli', 'custom'] as const;

// Configure templates for each tool
const TEMPLATES: Record<string, Record<string, unknown>> = {
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

// ==================== Page Components ====================

export default function ConfigsPage() {
  const { t, locale } = useI18n();
  const [items, setItems] = React.useState<ConfigTemplate[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [searchQuery, setSearchQuery] = React.useState('');

  // Editor dialog
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editItem, setEditItem] = React.useState<ConfigTemplate | null>(null);

  // Delete dialog
  const [deleteItem, setDeleteItem] = React.useState<ConfigTemplate | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Editor Form Status
  const [formName, setFormName] = React.useState('');
  const [formType, setFormType] = React.useState('claude_code');
  const [formPayload, setFormPayload] = React.useState('{}');

  // ==================== Data collection ====================

  const fetchConfigs = React.useCallback(async (q?: string) => {
    try {
      const url = q ? `/api/configs?q=${encodeURIComponent(q)}` : '/api/configs';
      const res = await fetch(url);
      if (!res.ok) throw new Error('Failed to get configuration list');
      const json = await res.json();
      setItems(Array.isArray(json.data) ? json.data : []);
    } catch {
      toast.error(t('configs.toast.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  // Search anti-shake
  const searchTimerRef = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const handleSearch = (value: string) => {
    setSearchQuery(value);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      fetchConfigs(value.trim() || undefined);
    }, 300);
  };

  // ==================== Form Action ====================

  const resetForm = (type = 'claude_code') => {
    setFormName('');
    setFormType(type);
    setFormPayload(JSON.stringify(TEMPLATES[type] ?? {}, null, 2));
  };

  const openCreate = () => {
    resetForm();
    setEditItem(null);
    setEditorOpen(true);
  };

  const openEdit = (item: ConfigTemplate) => {
    setEditItem(item);
    setFormName(item.name);
    setFormType(item.configType);
    setFormPayload(JSON.stringify(item.configPayload, null, 2));
    setEditorOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim()) {
      toast.error(t('configs.toast.nameRequired'));
      return;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(formPayload);
    } catch {
      toast.error(t('configs.toast.invalidJson'));
      return;
    }

    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: formName.trim(),
        configType: formType,
        configPayload: payload,
      };

      const url = editItem ? `/api/configs/${editItem.id}` : '/api/configs';
      const method = editItem ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || t('common.saveFailed'));
        return;
      }

      toast.success(editItem ? t('configs.toast.updated') : t('configs.toast.created'));
      setEditorOpen(false);
      fetchConfigs(searchQuery.trim() || undefined);
    } catch {
      toast.error(t('common.saveFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteItem) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/configs/${deleteItem.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || t('common.deleteFailed'));
        return;
      }
      toast.success(t('configs.toast.deleted'));
      setDeleteItem(null);
      fetchConfigs(searchQuery.trim() || undefined);
    } catch {
      toast.error(t('common.deleteFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const copyPayload = (item: ConfigTemplate) => {
    navigator.clipboard.writeText(JSON.stringify(item.configPayload, null, 2));
    toast.success(t('configs.toast.copied'));
  };

  // ==================== rendered ====================

  return (
    <div className="space-y-4">
      {/* Page Head */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('configs.title')}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t('configs.subtitleShort')}
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-2 h-4 w-4" />
          {t('configs.create')}
        </Button>
      </div>

      {/* search bar */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={t('configs.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => handleSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Configure the Listdom */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <FileJson className="h-12 w-12 mb-3 opacity-40" />
          <p>{searchQuery ? t('configs.empty.search') : t('configs.empty.default')}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <Card key={item.id}>
              <CardContent className="pt-5 pb-4">
                <div className="flex items-start justify-between">
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold text-base">{item.name}</h3>
                      <Badge variant="secondary">
                        {t(`configs.type.${item.configType}`)}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {t('configs.versionLine', {
                        version: String(item.version),
                        time: format(new Date(item.updatedAt), 'yyyy-MM-dd HH:mm', { locale: dateFnsLocale(locale) }),
                      })}
                    </p>
                  </div>
                  <div className="flex gap-1 shrink-0 ml-4">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => copyPayload(item)}
                      title={t('configs.copyTitle')}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => openEdit(item)}
                      title={t('common.edit')}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive"
                      onClick={() => setDeleteItem(item)}
                      title={t('common.delete')}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ==================== Editors Dialog ==================== */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{editItem ? t('configs.dialog.edit.title') : t('configs.dialog.create.title')}</DialogTitle>
            <DialogDescription>
              {t('configs.dialog.create.desc')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 flex-1 min-h-0">
            {/* Basic Information */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('configs.field.name')}</Label>
                <Input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder={t('configs.field.namePlaceholderFull')}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('configs.field.type')}</Label>
                <Select
                  value={formType}
                  onValueChange={(v) => {
                    setFormType(v);
                    if (!editItem) {
                      setFormPayload(JSON.stringify(TEMPLATES[v] ?? {}, null, 2));
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CONFIG_TYPE_VALUES.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(`configs.type.${value}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* JSON Editors */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t('configs.field.payloadLabel')}</Label>
                {!editItem && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      setFormPayload(JSON.stringify(TEMPLATES[formType] ?? {}, null, 2));
                    }}
                  >
                    {t('configs.resetTemplate')}
                  </Button>
                )}
              </div>
              <JsonEditor value={formPayload} onChange={setFormPayload} height="350px" />
            </div>
          </div>

          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setEditorOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={submitting || !formName.trim()}>
              {submitting ? t('configs.saving') : editItem ? t('common.save') : t('configs.create.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ==================== Deletion confirmation Dialog ==================== */}
      <Dialog open={!!deleteItem} onOpenChange={() => setDeleteItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('configs.dialog.delete.title')}</DialogTitle>
            <DialogDescription>
              {t('configs.dialog.delete.desc', { name: deleteItem?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteItem(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={submitting}>
              {submitting ? t('configs.deleting') : t('configs.delete.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
