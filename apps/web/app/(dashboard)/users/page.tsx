'use client';

import React from 'react';
import { toast } from 'sonner';
import { Pencil, Plus, Shield, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';

interface UserItem {
  id: string;
  email: string;
  name: string | null;
  role: string;
  deviceCount: number;
  createdAt: string;
  updatedAt: string;
}

const ROLE_VARIANT: Record<string, 'default' | 'destructive' | 'secondary'> = {
  super_admin: 'destructive',
  admin: 'default',
  viewer: 'secondary',
};

export default function UsersPage() {
  const { t } = useI18n();
  const [users, setUsers] = React.useState<UserItem[]>([]);
  const [selectedUserId, setSelectedUserId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editUser, setEditUser] = React.useState<UserItem | null>(null);
  const [deleteUser, setDeleteUser] = React.useState<UserItem | null>(null);

  const [formEmail, setFormEmail] = React.useState('');
  const [formName, setFormName] = React.useState('');
  const [formPassword, setFormPassword] = React.useState('');
  const [formRole, setFormRole] = React.useState<string>('viewer');
  const [submitting, setSubmitting] = React.useState(false);

  const fetchUsers = React.useCallback(async () => {
    try {
      const res = await fetch('/api/users');
      if (res.status === 403) {
        toast.error(t('users.toast.forbidden'));
        return;
      }
      if (!res.ok) throw new Error('Error getting list of users');
      const json = await res.json();
      setUsers(json.data);
      console.debug('[User Management] Query complete:', json.data.length);
    } catch (error) {
      toast.error(t('users.toast.loadFailed'));
      console.error('[User Management] Request failed:', error);
    } finally {
      setLoading(false);
    }
  }, [t]);

  React.useEffect(() => { fetchUsers(); }, [fetchUsers]);

  React.useEffect(() => {
    if (users.length === 0) {
      setSelectedUserId(null);
      return;
    }
    if (!selectedUserId || !users.some((item) => item.id === selectedUserId)) {
      setSelectedUserId(users[0].id);
    }
  }, [users, selectedUserId]);

  const selectedUser = React.useMemo(
    () => users.find((item) => item.id === selectedUserId) ?? null,
    [users, selectedUserId],
  );

  const resetForm = () => {
    setFormEmail('');
    setFormName('');
    setFormPassword('');
    setFormRole('viewer');
  };

  const roleLabel = React.useCallback((role: string) => (
    role === 'super_admin' ? t('users.role.superAdmin')
      : role === 'admin' ? t('users.role.admin')
        : role === 'viewer' ? t('users.role.viewer')
          : role
  ), [t]);

  const handleCreate = async () => {
    setSubmitting(true);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formEmail, password: formPassword, name: formName || undefined, role: formRole }),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || t('users.toast.createFailed'));
        return;
      }
      toast.success(t('users.toast.created'));
      setCreateOpen(false);
      resetForm();
      fetchUsers();
    } catch { toast.error(t('users.toast.createFailed')); }
    finally { setSubmitting(false); }
  };

  const handleEdit = async () => {
    if (!editUser) return;
    setSubmitting(true);
    try {
      const body: Record<string, string> = { role: formRole };
      if (formPassword) body.password = formPassword;
      if (formName) body.name = formName;

      const res = await fetch(`/api/users/${editUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || t('users.toast.updateFailed'));
        return;
      }
      toast.success(t('users.toast.updated'));
      setEditUser(null);
      resetForm();
      fetchUsers();
    } catch { toast.error(t('users.toast.updateFailed')); }
    finally { setSubmitting(false); }
  };

  const handleDelete = async () => {
    if (!deleteUser) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/users/${deleteUser.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || t('common.deleteFailed'));
        return;
      }
      toast.success(t('users.toast.deleted'));
      setDeleteUser(null);
      fetchUsers();
    } catch { toast.error(t('common.deleteFailed')); }
    finally { setSubmitting(false); }
  };

  const openEdit = (user: UserItem) => {
    setEditUser(user);
    setFormRole(user.role);
    setFormName(user.name ?? '');
    setFormPassword('');
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => { resetForm(); setCreateOpen(true); }}>
          <Plus className="mr-2 h-4 w-4" />{t('users.create')}
        </Button>
      </div>

      {loading ? (
        <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(420px,560px)_minmax(0,1fr)]">
          <div className="rounded-lg border border-border/70">
            <div className="max-h-[calc(100vh-280px)] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('users.col.user')}</TableHead>
                    <TableHead>{t('users.col.role')}</TableHead>
                    <TableHead>{t('users.col.deviceCount')}</TableHead>
                    <TableHead>{t('users.col.createdAt')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((user) => {
                    const roleVariant = ROLE_VARIANT[user.role] ?? 'secondary' as const;
                    const selected = user.id === selectedUser?.id;
                    return (
                      <TableRow key={user.id} className={cn('cursor-pointer', selected && 'bg-muted/35')} onClick={() => setSelectedUserId(user.id)}>
                        <TableCell>
                          <div>
                            <p className="font-medium">{user.name || user.email}</p>
                            <p className="text-xs text-muted-foreground">{user.email}</p>
                          </div>
                        </TableCell>
                        <TableCell><Badge variant={roleVariant}>{roleLabel(user.role)}</Badge></TableCell>
                        <TableCell className="font-mono tabular-nums">{user.deviceCount}</TableCell>
                        <TableCell className="text-sm">{format(new Date(user.createdAt), 'yyyy-MM-dd')}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </div>

          <Card className="border-border/70">
            <CardContent className="space-y-5 py-5">
              {selectedUser ? (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-lg font-semibold">{selectedUser.name || selectedUser.email}</h2>
                      <p className="mt-1 text-sm text-muted-foreground">{selectedUser.email}</p>
                    </div>
                    <Badge variant={ROLE_VARIANT[selectedUser.role] ?? 'secondary'}>
                      <Shield className="mr-1 h-3.5 w-3.5" />
                      {roleLabel(selectedUser.role)}
                    </Badge>
                  </div>

                  <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">{t('users.col.role')}</dt>
                      <dd>{roleLabel(selectedUser.role)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t('users.col.deviceCount')}</dt>
                      <dd>{selectedUser.deviceCount}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">{t('users.col.createdAt')}</dt>
                      <dd>{format(new Date(selectedUser.createdAt), 'yyyy-MM-dd HH:mm')}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Updated</dt>
                      <dd>{format(new Date(selectedUser.updatedAt), 'yyyy-MM-dd HH:mm')}</dd>
                    </div>
                  </dl>

                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" onClick={() => openEdit(selectedUser)}>
                      <Pencil className="mr-2 h-4 w-4" />{t('common.edit')}
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => setDeleteUser(selectedUser)}>
                      <Trash2 className="mr-2 h-4 w-4" />{t('common.delete')}
                    </Button>
                  </div>
                </>
              ) : (
                <div className="py-10 text-center text-sm text-muted-foreground">{t('users.title')}</div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{t('users.dialog.create.title')}</DialogTitle>
            <DialogDescription>{t('users.dialog.create.desc')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t('users.field.email')}</Label>
              <Input type="email" value={formEmail} onChange={(e) => setFormEmail(e.target.value)} placeholder="user@example.com" />
            </div>
            <div className="space-y-1.5">
              <Label>{t('users.field.name')} ({t('common.optional')})</Label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder={t('users.field.name')} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('users.field.password')}</Label>
              <Input type="password" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} placeholder={t('users.field.passwordPlaceholder')} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t('users.col.role')}</Label>
              <Select value={formRole} onValueChange={setFormRole}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">{t('users.role.viewer')}</SelectItem>
                  <SelectItem value="admin">{t('users.role.admin')}</SelectItem>
                  <SelectItem value="super_admin">{t('users.role.superAdmin')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
            <Button onClick={handleCreate} disabled={submitting || !formEmail || !formPassword}>{t('common.create')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editUser} onOpenChange={(open) => !open && setEditUser(null)}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{t('users.dialog.edit.title')}</DialogTitle>
            <DialogDescription>{editUser?.email}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('users.field.name')}</Label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('users.field.passwordEditLabel')}</Label>
              <Input type="password" value={formPassword} onChange={(e) => setFormPassword(e.target.value)} placeholder={t('users.field.passwordEditPlaceholder')} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label>{t('users.col.role')}</Label>
              <Select value={formRole} onValueChange={setFormRole}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">{t('users.role.viewer')}</SelectItem>
                  <SelectItem value="admin">{t('users.role.admin')}</SelectItem>
                  <SelectItem value="super_admin">{t('users.role.superAdmin')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditUser(null)}>{t('common.cancel')}</Button>
            <Button onClick={handleEdit} disabled={submitting}>{t('common.save')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteUser} onOpenChange={(open) => !open && setDeleteUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('users.dialog.delete.title')}</DialogTitle>
            <DialogDescription>
              {t('users.dialog.delete.desc', { email: deleteUser?.email ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteUser(null)}>{t('common.cancel')}</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={submitting}>{t('common.delete')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
