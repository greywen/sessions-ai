'use client';

import React from 'react';
import { toast } from 'sonner';
import { Plus, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { format } from 'date-fns';
import { ModelLogo, ProviderLogo } from '@/components/branding/ai-logo';
import { useI18n } from '@/lib/i18n/provider';
import { DatePicker } from '@/components/shared/date-picker';

interface PricingItem {
  id: string;
  model: string;
  provider: string;
  inputPricePerMtok: string;
  outputPricePerMtok: string;
  cachePricePerMtok: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  syncSource: 'manual' | 'openrouter';
  syncLocked: boolean;
  lastSyncedAt: string | null;
  createdAt: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
};

export default function PricingPage() {
  const { t } = useI18n();
  const [items, setItems] = React.useState<PricingItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editItem, setEditItem] = React.useState<PricingItem | null>(null);
  const [deleteItem, setDeleteItem] = React.useState<PricingItem | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);

  // Form Status
  const [formModel, setFormModel] = React.useState('');
  const [formProvider, setFormProvider] = React.useState('');
  const [formInputPrice, setFormInputPrice] = React.useState('');
  const [formOutputPrice, setFormOutputPrice] = React.useState('');
  const [formCachePrice, setFormCachePrice] = React.useState('');
  const [formEffectiveFrom, setFormEffectiveFrom] = React.useState('');
  const [formEffectiveTo, setFormEffectiveTo] = React.useState('');

  const fetchPricing = React.useCallback(async () => {
    try {
      const res = await fetch('/api/pricing');
      if (!res.ok) throw new Error('Failed to get pricing table');
      const json = await res.json();
      setItems(json.data);
      console.debug('[Pricing Table] Query complete:', json.data.length);
    } catch (error) {
      toast.error(t('pricing.toast.loadFailed'));
      console.error('[Pricing Table] Request failed:', error);
    } finally {
      setLoading(false);
    }
  }, [t]);

  React.useEffect(() => { fetchPricing(); }, [fetchPricing]);

  const resetForm = () => {
    setFormModel('');
    setFormProvider('');
    setFormInputPrice('');
    setFormOutputPrice('');
    setFormCachePrice('');
    setFormEffectiveFrom('');
    setFormEffectiveTo('');
  };

  const openCreate = () => {
    resetForm();
    setEditItem(null);
    setDialogOpen(true);
  };

  const openEdit = (item: PricingItem) => {
    setEditItem(item);
    setFormModel(item.model);
    setFormProvider(item.provider);
    setFormInputPrice(item.inputPricePerMtok);
    setFormOutputPrice(item.outputPricePerMtok);
    setFormCachePrice(item.cachePricePerMtok ?? '');
    setFormEffectiveFrom(item.effectiveFrom);
    setFormEffectiveTo(item.effectiveTo ?? '');
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const payload = {
        model: formModel,
        provider: formProvider,
        inputPricePerMtok: formInputPrice,
        outputPricePerMtok: formOutputPrice,
        cachePricePerMtok: formCachePrice || null,
        effectiveFrom: formEffectiveFrom,
        effectiveTo: formEffectiveTo || null,
      };

      const url = editItem ? `/api/pricing/${editItem.id}` : '/api/pricing';
      const method = editItem ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || t('common.operationFailed'));
        return;
      }

      toast.success(editItem ? t('pricing.toast.updated') : t('pricing.toast.created'));
      setDialogOpen(false);
      resetForm();
      fetchPricing();
    } catch {
      toast.error(t('common.operationFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteItem) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/pricing/${deleteItem.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || t('common.deleteFailed'));
        return;
      }
      toast.success(t('pricing.toast.deleted'));
      setDeleteItem(null);
      fetchPricing();
    } catch {
      toast.error(t('common.deleteFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSyncOpenRouter = async () => {
    setSyncing(true);
    try {
      const res = await fetch('/api/pricing/sync/openrouter', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || t('common.operationFailed'));
        return;
      }
      const data = json.data as {
        inserted: number;
        updated: number;
        skippedLocked: number;
      };
      toast.success(t('pricing.sync.toast.success', {
        inserted: data.inserted,
        updated: data.updated,
        skippedLocked: data.skippedLocked,
      }));
      fetchPricing();
    } catch {
      toast.error(t('pricing.sync.toast.failed'));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('pricing.title')}</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleSyncOpenRouter} disabled={syncing}>
            <RefreshCw className={`mr-2 h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? t('pricing.syncing') : t('pricing.sync')}
          </Button>
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />{t('pricing.addNew')}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('pricing.col.model')}</TableHead>
              <TableHead>{t('pricing.col.provider')}</TableHead>
              <TableHead className="text-right">{t('pricing.col.inputPrice')}</TableHead>
              <TableHead className="text-right">{t('pricing.col.outputPrice')}</TableHead>
              <TableHead className="text-right">{t('pricing.col.cachePrice')}</TableHead>
              <TableHead>{t('pricing.col.effectiveFrom')}</TableHead>
              <TableHead>{t('pricing.col.effectiveTo')}</TableHead>
              <TableHead className="w-[100px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const providerLabel = PROVIDER_LABELS[item.provider] ?? item.provider;
              return (
                <TableRow key={item.id}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2 font-mono">
                      <ModelLogo model={item.model} provider={item.provider} size={16} />
                      <span>{item.model}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">
                        <ProviderLogo provider={item.provider} size={14} />
                        {providerLabel}
                      </Badge>
                      {item.syncLocked ? (
                        <Badge variant="secondary">{t('pricing.badge.manualLocked')}</Badge>
                      ) : item.syncSource === 'openrouter' ? (
                        <Badge variant="outline">{t('pricing.badge.synced')}</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">${item.inputPricePerMtok}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">${item.outputPricePerMtok}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {item.cachePricePerMtok ? `$${item.cachePricePerMtok}` : '-'}
                  </TableCell>
                  <TableCell>{item.effectiveFrom}</TableCell>
                  <TableCell>{item.effectiveTo ?? '-'}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(item)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" onClick={() => setDeleteItem(item)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                  {t('pricing.empty')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editItem ? t('pricing.dialog.edit.title') : t('pricing.dialog.create.title')}</DialogTitle>
            <DialogDescription>{t('pricing.dialog.create.desc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('pricing.field.model')}</Label>
                <Input value={formModel} onChange={(e) => setFormModel(e.target.value)} placeholder="claude-sonnet-4-6" />
              </div>
              <div className="space-y-2">
                <Label>{t('pricing.field.provider')}</Label>
                <Input value={formProvider} onChange={(e) => setFormProvider(e.target.value)} placeholder="anthropic" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>{t('pricing.field.inputPrice')}</Label>
                <Input type="number" step="0.0001" value={formInputPrice} onChange={(e) => setFormInputPrice(e.target.value)} placeholder="3.0000" />
              </div>
              <div className="space-y-2">
                <Label>{t('pricing.field.outputPrice')}</Label>
                <Input type="number" step="0.0001" value={formOutputPrice} onChange={(e) => setFormOutputPrice(e.target.value)} placeholder="15.0000" />
              </div>
              <div className="space-y-2">
                <Label>{t('pricing.field.cachePrice')}</Label>
                <Input type="number" step="0.0001" value={formCachePrice} onChange={(e) => setFormCachePrice(e.target.value)} placeholder="0.3000" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t('pricing.field.effectiveFrom')}</Label>
                <DatePicker value={formEffectiveFrom} onChange={setFormEffectiveFrom} />
              </div>
              <div className="space-y-2">
                <Label>{t('pricing.field.effectiveTo')}</Label>
                <DatePicker value={formEffectiveTo} onChange={setFormEffectiveTo} clearable />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleSubmit} disabled={submitting || !formModel || !formProvider || !formInputPrice || !formOutputPrice || !formEffectiveFrom}>
              {submitting ? t('pricing.submitting') : editItem ? t('common.save') : t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation Dialog */}
      <Dialog open={!!deleteItem} onOpenChange={() => setDeleteItem(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pricing.dialog.delete.title')}</DialogTitle>
            <DialogDescription>
              {t('pricing.dialog.delete.desc', { model: deleteItem?.model ?? '', provider: deleteItem?.provider ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteItem(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={submitting}>
              {submitting ? t('pricing.deleting') : t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
