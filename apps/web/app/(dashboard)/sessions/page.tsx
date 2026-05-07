'use client';

import React from 'react';
import { toast } from 'sonner';
import { MessageSquare, Search, Star } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { TOOL_COLORS } from '@sessions-ai/shared';
import type { ContentBlock, TokenUsage } from '@sessions-ai/shared';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TimeRangeSelector, getDefaultRange, rangeToIsoBounds, type TimeRangeValue } from '@/components/shared/time-range-selector';
import { ModelLogo, ToolLogo, getToolLabel } from '@/components/branding/ai-logo';
import { ContentBlockRenderer } from '@/components/sessions/content-block-renderer';
import { TokenUsageBar } from '@/components/sessions/token-usage-bar';
import { useI18n } from '@/lib/i18n/provider';
import { dateFnsLocale } from '@/lib/i18n/date-locale';
import { cn } from '@/lib/utils';

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
  isFavorite: boolean;
}

interface SessionMeta {
  sessionId: string;
  sessionTitle: string | null;
  isFavorite: boolean;
  sourceTool: string;
  machineId: string;
  messageCount: number;
  firstMessageAt: string;
  lastMessageAt: string;
  deviceName: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  totalCost: number;
}

interface SessionMessageItem {
  id: string;
  sourceTool: string;
  role: string;
  contentBlocks: ContentBlock[] | null;
  usage: TokenUsage | null;
  rawTimestamp: string;
}

interface SessionsResponse {
  data: SessionItem[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

interface SessionMetaResponse {
  data: SessionMeta;
}

interface SessionMessagesResponse {
  data: SessionMessageItem[];
}

interface UserItem {
  id: string;
  name: string | null;
  email: string;
}

function formatNumber(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString() : '0';
}

export default function SessionsPage() {
  const { t, locale } = useI18n();
  const [sessions, setSessions] = React.useState<SessionItem[]>([]);
  const [selectedSessionId, setSelectedSessionId] = React.useState<string | null>(null);
  const [selectedMeta, setSelectedMeta] = React.useState<SessionMeta | null>(null);
  const [detailMessages, setDetailMessages] = React.useState<SessionMessageItem[]>([]);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [pagination, setPagination] = React.useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [toolFilter, setToolFilter] = React.useState<string>('all');
  const [userFilter, setUserFilter] = React.useState<string>('all');
  const [favoriteFilter, setFavoriteFilter] = React.useState<'all' | 'favorited' | 'unfavorited'>('all');
  const [timeRange, setTimeRange] = React.useState<TimeRangeValue>(() => getDefaultRange(30));
  const [searchInput, setSearchInput] = React.useState('');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [users, setUsers] = React.useState<UserItem[]>([]);
  const [togglingSessions, setTogglingSessions] = React.useState<Record<string, boolean>>({});
  const searchTimer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const loadingMoreRef = React.useRef(false);
  const paginationRef = React.useRef(pagination);
  const listScrollRef = React.useRef<HTMLDivElement>(null);
  const loadMoreRef = React.useRef<HTMLDivElement>(null);
  const detailCacheRef = React.useRef<Map<string, { meta: SessionMeta; messages: SessionMessageItem[] }>>(new Map());
  const detailAbortRef = React.useRef<AbortController | null>(null);

  const fetchSessions = React.useCallback(async (page = 1, append = false) => {
    if (append) setLoadingMore(true); else setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('limit', '20');
      if (toolFilter !== 'all') params.set('sourceTool', toolFilter);
      if (userFilter !== 'all') params.set('userId', userFilter);
      if (favoriteFilter === 'favorited') params.set('favorite', 'true');
      if (favoriteFilter === 'unfavorited') params.set('favorite', 'false');
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
    } catch (error) {
      toast.error(t('sessions.toast.loadFailed'));
      console.error('[Sessions list] Request failed:', error);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [toolFilter, userFilter, favoriteFilter, timeRange, searchQuery, t]);

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

  React.useEffect(() => {
    if (sessions.length === 0) {
      setSelectedSessionId(null);
      return;
    }
    if (!selectedSessionId || !sessions.some((item) => item.sessionId === selectedSessionId)) {
      setSelectedSessionId(sessions[0].sessionId);
    }
  }, [sessions, selectedSessionId]);

  const selectedSession = React.useMemo(
    () => sessions.find((item) => item.sessionId === selectedSessionId) ?? null,
    [sessions, selectedSessionId],
  );

  React.useEffect(() => {
    if (!selectedSessionId) {
      detailAbortRef.current?.abort();
      detailAbortRef.current = null;
      setSelectedMeta(null);
      setDetailMessages([]);
      setDetailLoading(false);
      return;
    }

    const cached = detailCacheRef.current.get(selectedSessionId);
    if (cached) {
      setSelectedMeta(cached.meta);
      setDetailMessages(cached.messages);
      setDetailLoading(false);
      return;
    }

    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;

    let cancelled = false;
    setDetailLoading(true);

    Promise.all([
      fetch(`/api/sessions/${encodeURIComponent(selectedSessionId)}`, { signal: controller.signal }).then((res) => {
        if (!res.ok) throw new Error('Failed to load session meta');
        return res.json() as Promise<SessionMetaResponse>;
      }),
      fetch(`/api/sessions/${encodeURIComponent(selectedSessionId)}/messages?limit=12&lite=true`, { signal: controller.signal }).then((res) => {
        if (!res.ok) throw new Error('Failed to load session messages');
        return res.json() as Promise<SessionMessagesResponse>;
      }),
    ])
      .then(([metaJson, msgJson]) => {
        if (cancelled) return;
        setSelectedMeta(metaJson.data);
        setDetailMessages(msgJson.data ?? []);
        detailCacheRef.current.set(selectedSessionId, {
          meta: metaJson.data,
          messages: msgJson.data ?? [],
        });
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setSelectedMeta(null);
        setDetailMessages([]);
        toast.error(t('session.detail.toast.messagesFailed'));
        console.error('[Sessions page] Detail load failed:', error);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (detailAbortRef.current === controller) {
        detailAbortRef.current = null;
      }
    };
  }, [selectedSessionId, t]);

  const toggleSessionFavorite = React.useCallback(async (sessionId: string, currentFavorite: boolean) => {
    if (togglingSessions[sessionId]) return;
    const nextFavorite = !currentFavorite;
    setTogglingSessions((prev) => ({ ...prev, [sessionId]: true }));

    setSessions((prev) => {
      const updated = prev.map((item) => (
        item.sessionId === sessionId ? { ...item, isFavorite: nextFavorite } : item
      ));
      if (favoriteFilter === 'favorited' && !nextFavorite) {
        return updated.filter((item) => item.sessionId !== sessionId);
      }
      if (favoriteFilter === 'unfavorited' && nextFavorite) {
        return updated.filter((item) => item.sessionId !== sessionId);
      }
      return updated;
    });

    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite: nextFavorite }),
      });
      if (!res.ok) throw new Error('Failed to update session favorite status');

      if (favoriteFilter !== 'all') {
        fetchSessions(1);
      }
    } catch (error) {
      setSessions((prev) => prev.map((item) => (
        item.sessionId === sessionId ? { ...item, isFavorite: currentFavorite } : item
      )));
      toast.error(t('common.operationFailed'));
      console.error('[Sessions list] Favorite update failed:', error);
    } finally {
      setTogglingSessions((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    }
  }, [favoriteFilter, fetchSessions, t, togglingSessions]);

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setSearchQuery(value.trim());
    }, 300);
  };

  const handleLoadMore = React.useCallback(() => {
    if (loadingMoreRef.current) return;
    if (paginationRef.current.page >= paginationRef.current.totalPages) return;
    loadingMoreRef.current = true;
    void fetchSessions(paginationRef.current.page + 1, true)
      .finally(() => {
        loadingMoreRef.current = false;
      });
  }, [fetchSessions]);

  paginationRef.current = pagination;

  React.useEffect(() => {
    const root = listScrollRef.current;
    const target = loadMoreRef.current;
    if (!target || !root) return;
    if (typeof window !== 'undefined' && !window.matchMedia('(min-width: 1024px)').matches) return;
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
      { root, threshold: 0.1, rootMargin: '0px 0px 120px 0px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [handleLoadMore, sessions.length]);

  const getToolColor = (tool: string) => {
    return TOOL_COLORS[tool] ?? { text: 'text-gray-600', bg: 'bg-gray-100' };
  };

  const resolveSessionTitle = React.useCallback((item: Pick<SessionItem, 'sessionTitle' | 'firstUserMessage' | 'sourceTool'> | null | undefined) => {
    if (!item) return t('sessions.untitled');
    const title = item.sessionTitle?.trim();
    if (title) return title;

    const fallbackFromMessage = item.firstUserMessage?.trim();
    if (fallbackFromMessage) {
      return fallbackFromMessage.length > 42 ? `${fallbackFromMessage.slice(0, 42)}...` : fallbackFromMessage;
    }

    return `${getToolLabel(item.sourceTool)} Session`;
  }, [t]);

  const detailTitle = selectedMeta?.sessionTitle?.trim()
    || resolveSessionTitle(selectedSession)
    || t('sessions.untitled');
  const detailSourceTool = selectedMeta?.sourceTool || selectedSession?.sourceTool || '';
  const detailMessageCount = selectedMeta?.messageCount ?? selectedSession?.messageCount ?? 0;
  const totalInputTokens = selectedMeta?.totalInputTokens ?? 0;
  const totalOutputTokens = selectedMeta?.totalOutputTokens ?? 0;
  const totalCacheTokens = selectedMeta?.totalCacheTokens ?? 0;
  const totalTokens = totalInputTokens + totalOutputTokens + totalCacheTokens;
  const totalCost = selectedMeta?.totalCost ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('sessions.searchPlaceholder')}
            className="h-9 pl-8 bg-background"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
        </div>
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
            <SelectItem value="QwenCode">Qcoder</SelectItem>
            <SelectItem value="CodeBuddy">CodeBuddy</SelectItem>
          </SelectContent>
        </Select>
        <Select value={userFilter} onValueChange={setUserFilter}>
          <SelectTrigger className="h-9 w-[140px] bg-background"><SelectValue placeholder={t('sessions.filter.user')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('sessions.filter.allUsers')}</SelectItem>
            {users.map((u) => (
              <SelectItem key={u.id} value={u.id}>{u.name ?? u.email}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={favoriteFilter}
          onValueChange={(v) => { setFavoriteFilter(v as 'all' | 'favorited' | 'unfavorited'); }}
        >
          <SelectTrigger className="h-9 w-[160px] bg-background">
            <SelectValue placeholder={t('sessions.filter.favorite')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('sessions.filter.favorite.all')}</SelectItem>
            <SelectItem value="favorited">{t('sessions.filter.favorite.only')}</SelectItem>
            <SelectItem value="unfavorited">{t('sessions.filter.favorite.exclude')}</SelectItem>
          </SelectContent>
        </Select>
        <TimeRangeSelector value={timeRange} onChange={setTimeRange} className="h-9 bg-background" />
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[84px] w-full rounded-lg" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
          <MessageSquare className="h-12 w-12 mb-4" />
          <p className="text-lg">{t('sessions.empty.title')}</p>
          <p className="text-sm mt-1">{t('sessions.empty.subtitle')}</p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
          <div ref={listScrollRef} className="space-y-2 lg:max-h-[calc(100vh-230px)] lg:overflow-y-auto lg:pr-1">
            {sessions.map((s) => {
              const selected = s.sessionId === selectedSession?.sessionId;
              const title = resolveSessionTitle(s);

              return (
                <Card
                  key={s.sessionId}
                  className={cn(
                    'cursor-pointer border-border/70 transition-colors rounded-lg py-1',
                    selected ? 'bg-muted/35 ring-1 ring-border' : 'hover:bg-muted/35',
                  )}
                  onClick={() => setSelectedSessionId(s.sessionId)}
                >
                  <CardContent className="px-3 py-1">
                    <div className="flex items-center gap-2">
                      <ToolLogo tool={s.sourceTool} size={14} className="shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {title}
                          </span>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 shrink-0"
                            disabled={!!togglingSessions[s.sessionId]}
                            aria-label={s.isFavorite ? t('sessions.favorite.removeSession') : t('sessions.favorite.addSession')}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleSessionFavorite(s.sessionId, s.isFavorite);
                            }}
                          >
                            <Star
                              className={`h-3.5 w-3.5 ${s.isFavorite ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground'}`}
                            />
                          </Button>
                        </div>
                        <div className="mt-0.5 flex items-center justify-between text-[11px] text-muted-foreground">
                          <span>{t('sessions.messageCount', { count: s.messageCount })}</span>
                          <span>{formatDistanceToNow(new Date(s.lastMessageAt), { locale: dateFnsLocale(locale) })}</span>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}

            <div ref={loadMoreRef} className="flex justify-center py-3">
              {pagination.page < pagination.totalPages ? (
                loadingMore ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Skeleton className="h-4 w-4 rounded-full" />
                    <span className="text-sm">{t('common.loading')}</span>
                  </div>
                ) : (
                  <Button variant="outline" size="sm" onClick={handleLoadMore}>
                    {t('common.loadMore')}
                  </Button>
                )
              ) : null}
            </div>
          </div>

          <Card className="border-border/70 lg:sticky lg:top-[5.5rem] flex flex-col lg:max-h-[calc(100vh-6rem)]">
            <CardContent className="py-4 flex flex-col h-full overflow-hidden">
              {selectedSession ? (
                <>
                  <div className="mb-3 shrink-0">
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="truncate text-base font-semibold">{detailTitle}</h2>
                      {detailSourceTool && (
                        <Badge variant="outline" className={`${getToolColor(detailSourceTool).text} ${getToolColor(detailSourceTool).bg} border-0 px-2 py-0.5 text-[10px] font-medium`}>
                          {getToolLabel(detailSourceTool)}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3 lg:grid-cols-5">
                      <div className="rounded-md border px-2 py-1.5">
                        <p className="text-muted-foreground">{t('session.detail.input')}</p>
                        <p className="font-medium">{formatNumber(totalInputTokens)} {t('block.usage.unit')}</p>
                      </div>
                      <div className="rounded-md border px-2 py-1.5">
                        <p className="text-muted-foreground">{t('session.detail.output')}</p>
                        <p className="font-medium">{formatNumber(totalOutputTokens)} {t('block.usage.unit')}</p>
                      </div>
                      <div className="rounded-md border px-2 py-1.5">
                        <p className="text-muted-foreground">Cache</p>
                        <p className="font-medium">{formatNumber(totalCacheTokens)} {t('block.usage.unit')}</p>
                      </div>
                      <div className="rounded-md border px-2 py-1.5">
                        <p className="text-muted-foreground">Tokens</p>
                        <p className="font-medium">{formatNumber(totalTokens)} {t('block.usage.unit')}</p>
                      </div>
                      <div className="rounded-md border px-2 py-1.5">
                        <p className="text-muted-foreground">Cost</p>
                        <p className="font-medium">${totalCost.toFixed(4)} USD</p>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{t('sessions.messageCount', { count: detailMessageCount })}</span>
                      <span>/</span>
                      <span>{selectedMeta?.ownerName || selectedMeta?.ownerEmail || selectedSession.ownerName || selectedSession.ownerEmail || t('common.notAvailable')}</span>
                      <span>/</span>
                      <span>{selectedMeta?.deviceName || selectedSession.deviceName || t('common.notAvailable')}</span>
                    </div>
                  </div>

                  <div className="flex-1 min-h-[260px] overflow-y-auto space-y-2 pr-1 border-t pt-3">
                    {detailLoading ? (
                      Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-14 w-full" />
                      ))
                    ) : detailMessages.length === 0 ? (
                      <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-sm text-muted-foreground">
                        {t('session.detail.empty')}
                      </div>
                    ) : (
                      detailMessages.map((msg) => {
                        const isUser = msg.role === 'User';
                        const isAssistant = msg.role === 'Assistant';
                        const hasBlocks = (msg.contentBlocks?.length ?? 0) > 0;

                        return (
                          <div key={msg.id} className={cn('py-1.5', isUser ? 'pr-4' : 'pr-1')}>
                            {isAssistant ? (
                              <Card className="border-border/70 bg-muted/20">
                                <CardContent className="py-2.5">
                                  <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                                    <ToolLogo tool={msg.sourceTool} size={14} />
                                    {msg.usage?.model && (
                                      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                                        <ModelLogo model={msg.usage.model} size={12} />
                                        {msg.usage.model}
                                      </Badge>
                                    )}
                                    <span>{format(new Date(msg.rawTimestamp), 'MM-dd HH:mm:ss', { locale: dateFnsLocale(locale) })}</span>
                                  </div>
                                  <div className="space-y-1.5 text-sm">
                                    {hasBlocks ? (
                                      msg.contentBlocks!.map((block, i) => (
                                        <ContentBlockRenderer key={i} block={block} />
                                      ))
                                    ) : (
                                      <p className="text-muted-foreground">-</p>
                                    )}
                                  </div>
                                  {msg.usage && <TokenUsageBar usage={msg.usage} />}
                                </CardContent>
                              </Card>
                            ) : (
                              <div className={cn('rounded-lg border p-2.5', isUser ? 'bg-muted/10' : 'bg-muted/25')}>
                                <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
                                  <span>{msg.role}</span>
                                  <span>{format(new Date(msg.rawTimestamp), 'MM-dd HH:mm:ss', { locale: dateFnsLocale(locale) })}</span>
                                </div>
                                <div className="space-y-1.5 text-sm">
                                  {hasBlocks ? (
                                    msg.contentBlocks!.map((block, i) => (
                                      <ContentBlockRenderer key={i} block={block} />
                                    ))
                                  ) : (
                                    <p className="text-muted-foreground">-</p>
                                  )}
                                </div>
                                {msg.usage && <TokenUsageBar usage={msg.usage} />}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              ) : (
                <div className="py-10 text-center text-sm text-muted-foreground">{t('sessions.empty.title')}</div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
