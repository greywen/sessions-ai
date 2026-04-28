'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Search, MessageSquare } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TimeRangeSelector, getDefaultRange, rangeToIsoBounds, type TimeRangeValue } from '@/components/shared/time-range-selector';
import { TOOL_COLORS } from '@llm-sessions/shared';
import { ToolLogo, getToolLabel } from '@/components/branding/ai-logo';
import { formatDistanceToNow } from 'date-fns';
import { useI18n } from '@/lib/i18n/provider';
import { dateFnsLocale } from '@/lib/i18n/date-locale';

interface SessionItem {
  sessionId: string;
  sourceTool: string;
  machineId: string;
  messageCount: number;
  firstMessageAt: string;
  lastMessageAt: string;
  deviceName: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  firstUserMessage: string | null;
  sessionTitle: string | null;
}

interface SessionsResponse {
  data: SessionItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

interface UserItem {
  id: string;
  name: string | null;
  email: string;
}

export default function SessionsPage() {
  const router = useRouter();
  const { t, locale } = useI18n();
  const [sessions, setSessions] = React.useState<SessionItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [pagination, setPagination] = React.useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [toolFilter, setToolFilter] = React.useState<string>('all');
  const [userFilter, setUserFilter] = React.useState<string>('all');
  const [timeRange, setTimeRange] = React.useState<TimeRangeValue>(() => getDefaultRange(30));
  const [searchInput, setSearchInput] = React.useState('');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [users, setUsers] = React.useState<UserItem[]>([]);
  const searchTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const loadMoreRef = React.useRef<HTMLDivElement>(null);

  // Calculate Time Range's from / to in ISO
  const fetchSessions = React.useCallback(async (page = 1, append = false) => {
    if (append) setLoadingMore(true); else setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', '20');
      if (toolFilter !== 'all') params.set('sourceTool', toolFilter);
      if (userFilter !== 'all') params.set('userId', userFilter);
      const { fromIso, toIso } = rangeToIsoBounds(timeRange);
      params.set('from', fromIso);
      params.set('to', toIso);
      if (searchQuery) params.set('search', searchQuery);

      const res = await fetch(`/api/sessions?${params}`);
      if (!res.ok) throw new Error('Failed to get session list');
      const json: SessionsResponse = await res.json();

      if (append) {
        setSessions((prev) => [...prev, ...json.data]);
      } else {
        setSessions(json.data);
      }
      setPagination(json.pagination);

      console.debug('[Sessions list] Query complete:', { total: json.pagination.total, page: json.pagination.page });
    } catch (error) {
      toast.error(t('sessions.toast.loadFailed'));
      console.error('[Sessions list] Request failed:', error);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [toolFilter, userFilter, timeRange, searchQuery, t]);

  const fetchUsers = React.useCallback(async () => {
    try {
      const res = await fetch('/api/users');
      if (res.ok) {
        const json = await res.json();
        setUsers(json.data ?? []);
      }
    } catch { /* Non-critical */ }
  }, []);

  React.useEffect(() => {
    fetchSessions(1);
  }, [fetchSessions]);

  React.useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setSearchQuery(value.trim());
    }, 300);
  };

  const handleLoadMore = React.useCallback(() => {
    if (pagination.page < pagination.totalPages && !loadingMore) {
      fetchSessions(pagination.page + 1, true);
    }
  }, [fetchSessions, loadingMore, pagination.page, pagination.totalPages]);

  // IntersectionObserver Infinity(Endurance observer,Avoid loading Missed after disconnect)
  const loadingMoreRef = React.useRef(false);
  const paginationRef = React.useRef(pagination);
  loadingMoreRef.current = loadingMore;
  paginationRef.current = pagination;

  React.useEffect(() => {
    const target = loadMoreRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          entries[0]?.isIntersecting &&
          !loadingMoreRef.current &&
          paginationRef.current.page < paginationRef.current.totalPages
        ) {
          handleLoadMore();
        }
      },
      { threshold: 0.1, rootMargin: '0px 0px 200px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [handleLoadMore]);

  const getToolColor = (tool: string) => {
    return TOOL_COLORS[tool] ?? { text: 'text-gray-600', bg: 'bg-gray-100' };
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t('sessions.title')}</h1>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('sessions.searchPlaceholder')}
            className="pl-8"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </div>
        <Select value={toolFilter} onValueChange={(v) => { setToolFilter(v); }}>
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
        <Select value={userFilter} onValueChange={(v) => { setUserFilter(v); }}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder={t('sessions.filter.user')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('sessions.filter.allUsers')}</SelectItem>
            {users.map((u) => (
              <SelectItem key={u.id} value={u.id}>{u.name ?? u.email}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
      </div>

      {/* Sessions list */}
      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[120px] w-full rounded-lg" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <MessageSquare className="h-12 w-12 mb-4" />
          <p className="text-lg">{t('sessions.empty.title')}</p>
          <p className="text-sm mt-1">{t('sessions.empty.subtitle')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => {
            const toolColor = getToolColor(s.sourceTool);
            return (
              <Card
                key={s.sessionId}
                className="cursor-pointer border-border/70 transition-colors hover:bg-muted/35"
                onClick={() => router.push(`/sessions/${encodeURIComponent(s.sessionId)}`)}
              >
                <CardContent className="py-3">
                  <div className="flex items-start gap-3">
                    <ToolLogo tool={s.sourceTool} size={18} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2">
                          <Badge variant="outline" className={`${toolColor.text} ${toolColor.bg} border-0 px-2 py-0.5 text-[11px] font-medium`}>
                            {getToolLabel(s.sourceTool)}
                          </Badge>
                          {s.sessionTitle ? (
                            <span className="truncate text-sm font-medium text-foreground">
                              {s.sessionTitle}
                            </span>
                          ) : (
                            <span className="truncate font-mono text-xs text-muted-foreground">
                              {s.sessionId.length > 16 ? `${s.sessionId.slice(0, 16)}...` : s.sessionId}
                            </span>
                          )}
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(s.lastMessageAt), { addSuffix: true, locale: dateFnsLocale(locale) })}
                        </span>
                      </div>

                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        {s.ownerName && <span>@{s.ownerName}</span>}
                        {!s.ownerName && s.ownerEmail && <span>{s.ownerEmail}</span>}
                        {(s.ownerName || s.ownerEmail) && s.deviceName && <span>·</span>}
                        {s.deviceName && <span>{s.deviceName}</span>}
                        <span>·</span>
                        <span>{t('sessions.messageCount', { count: s.messageCount })}</span>
                      </div>

                      {s.firstUserMessage && (
                        <p className="mt-1 line-clamp-1 text-sm text-foreground/80">{s.firstUserMessage}</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}

          {/* Load More / Infinite Trigger(Always render sentinel) */}
          <div ref={loadMoreRef} className="flex justify-center py-4">
            {pagination.page < pagination.totalPages ? (
              loadingMore ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Skeleton className="h-4 w-4 rounded-full" />
                  <span className="text-sm">{t('common.loading')}</span>
                </div>
              ) : (
                <Button variant="outline" onClick={handleLoadMore}>
                  {t('common.loadMore')}
                </Button>
              )
            ) : null}
          </div>

          {/* Pagination Information */}
          <div className="text-center text-xs text-muted-foreground py-2">
            {t('sessions.totalCount', { count: pagination.total })}
          </div>
        </div>
      )}
    </div>
  );
}
