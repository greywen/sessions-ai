'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, MessageSquare, Star } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TOOL_COLORS } from '@sessions-ai/shared';
import type { ContentBlock, TokenUsage } from '@sessions-ai/shared';
import { format } from 'date-fns';
import { ContentBlockRenderer } from '@/components/sessions/content-block-renderer';
import { TokenUsageBar } from '@/components/sessions/token-usage-bar';
import { MessageMetaBadges } from '@/components/sessions/message-meta-badges';
import { ModelLogo, ToolLogo, getToolLabel } from '@/components/branding/ai-logo';
import { useI18n } from '@/lib/i18n/provider';
import { dateFnsLocale } from '@/lib/i18n/date-locale';

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
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  totalCost: number;
}

interface MessageItem {
  id: string;
  sessionId: string;
  parentId: string | null;
  machineId: string;
  sourceTool: string;
  role: string;
  contentBlocks: ContentBlock[] | null;
  usage: TokenUsage | null;
  rawTimestamp: string;
  metadata: Record<string, unknown> | null;
  isFavorite: boolean;
}

export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const resolvedParams = React.use(params);
  const sessionId = resolvedParams.id;

  const [meta, setMeta] = React.useState<SessionMeta | null>(null);
  const [messages, setMessages] = React.useState<MessageItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  const [hasOlder, setHasOlder] = React.useState(false);
  // oldest cursor: rawTimestamp of the earliest loaded message, used to fetch older pages
  const oldestCursorRef = React.useRef<string | null>(null);
  const fetchingOlderRef = React.useRef(false);

  const [togglingSessionFavorite, setTogglingSessionFavorite] = React.useState(false);
  const [togglingMessageFavorites, setTogglingMessageFavorites] = React.useState<Record<string, boolean>>({});

  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  // Preserve scroll position when prepending older messages
  const prevScrollHeightRef = React.useRef(0);
  const prevScrollTopRef = React.useRef(0);

  const fetchMeta = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) throw new Error('Failed to get session details');
      const json = await res.json();
      setMeta(json.data);
    } catch (error) {
      toast.error(t('session.detail.toast.metaFailed'));
      console.error('[Session detail] Meta fetch failed:', error);
    }
  }, [sessionId, t]);

  // Fetch latest N messages (first load). API returns ascending order.
  const fetchInitial = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/messages?limit=50&order=desc`);
      if (!res.ok) throw new Error('Failed to get messages');
      const json = await res.json();
      // API returns desc order for first page; reverse to display oldest-first
      const rows: MessageItem[] = (json.data as MessageItem[]).reverse();
      setMessages(rows);
      setHasOlder(!!json.nextCursor);
      // oldest cursor is the rawTimestamp of the earliest message in this batch
      oldestCursorRef.current = rows[0]?.rawTimestamp ?? null;
    } catch (error) {
      toast.error(t('session.detail.toast.messagesFailed'));
      console.error('[Session detail] Initial fetch failed:', error);
    } finally {
      setLoading(false);
    }
  }, [sessionId, t]);

  // Fetch older messages (scroll up). Uses before= cursor to get messages earlier than oldest loaded.
  const fetchOlder = React.useCallback(async () => {
    if (fetchingOlderRef.current || !hasOlder || !oldestCursorRef.current) return;
    fetchingOlderRef.current = true;
    setLoadingOlder(true);

    const container = scrollContainerRef.current;
    if (container) {
      prevScrollHeightRef.current = container.scrollHeight;
      prevScrollTopRef.current = container.scrollTop;
    }

    try {
      const params = new URLSearchParams();
      params.set('limit', '50');
      params.set('order', 'desc');
      params.set('before', oldestCursorRef.current);
      const res = await fetch(`/api/sessions/${sessionId}/messages?${params}`);
      if (!res.ok) throw new Error('Failed to get older messages');
      const json = await res.json();
      const older: MessageItem[] = (json.data as MessageItem[]).reverse();
      setHasOlder(!!json.nextCursor);
      if (older.length > 0) {
        oldestCursorRef.current = older[0]?.rawTimestamp ?? null;
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.id));
          return [...older.filter((m) => !existingIds.has(m.id)), ...prev];
        });
      }
    } catch (error) {
      toast.error(t('session.detail.toast.messagesFailed'));
      console.error('[Session detail] Older fetch failed:', error);
    } finally {
      setLoadingOlder(false);
      fetchingOlderRef.current = false;
    }
  }, [sessionId, t, hasOlder]);

  // After prepending older messages, restore scroll position so the view doesn't jump
  React.useLayoutEffect(() => {
    if (loadingOlder) return;
    const container = scrollContainerRef.current;
    if (!container || prevScrollHeightRef.current === 0) return;
    const addedHeight = container.scrollHeight - prevScrollHeightRef.current;
    if (addedHeight > 0) {
      container.scrollTop = prevScrollTopRef.current + addedHeight;
    }
    prevScrollHeightRef.current = 0;
  }, [messages, loadingOlder]);

  React.useEffect(() => {
    fetchMeta();
    fetchInitial();
  }, [fetchMeta, fetchInitial]);

  // Scroll-up sentinel: load older messages when user scrolls near the top
  React.useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const onScroll = () => {
      if (container.scrollTop < 200 && hasOlder && !fetchingOlderRef.current) {
        void fetchOlder();
      }
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [fetchOlder, hasOlder]);

  // Scroll to bottom on initial load
  React.useEffect(() => {
    if (loading) return;
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
    }
  }, [loading]);

  const toggleSessionFavorite = React.useCallback(async () => {
    if (!meta || togglingSessionFavorite) return;
    const nextFavorite = !meta.isFavorite;
    setTogglingSessionFavorite(true);
    setMeta((prev) => (prev ? { ...prev, isFavorite: nextFavorite } : prev));
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorite: nextFavorite }),
      });
      if (!res.ok) throw new Error('Failed to update session favorite status');
    } catch (error) {
      setMeta((prev) => (prev ? { ...prev, isFavorite: !nextFavorite } : prev));
      toast.error(t('common.operationFailed'));
      console.error('[Session detail] Session favorite update failed:', error);
    } finally {
      setTogglingSessionFavorite(false);
    }
  }, [meta, sessionId, t, togglingSessionFavorite]);

  const toggleMessageFavorite = React.useCallback(async (messageId: string, currentFavorite: boolean) => {
    if (togglingMessageFavorites[messageId]) return;
    const nextFavorite = !currentFavorite;
    setTogglingMessageFavorites((prev) => ({ ...prev, [messageId]: true }));
    setMessages((prev) => prev.map((item) => (
      item.id === messageId ? { ...item, isFavorite: nextFavorite } : item
    )));
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/favorite`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ favorite: nextFavorite }),
        },
      );
      if (!res.ok) throw new Error('Failed to update message favorite status');
    } catch (error) {
      setMessages((prev) => prev.map((item) => (
        item.id === messageId ? { ...item, isFavorite: currentFavorite } : item
      )));
      toast.error(t('common.operationFailed'));
      console.error('[Session detail] Message favorite update failed:', error);
    } finally {
      setTogglingMessageFavorites((prev) => {
        const next = { ...prev };
        delete next[messageId];
        return next;
      });
    }
  }, [sessionId, t, togglingMessageFavorites]);

  const getToolColor = (tool: string) => TOOL_COLORS[tool] ?? { text: 'text-gray-600', bg: 'bg-gray-100' };

  const formatTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  // Virtual list: estimateSize keeps the DOM lean regardless of message count
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 120,
    overscan: 5,
  });

  if (loading && !meta) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-20 w-full" />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-theme(spacing.14)-theme(spacing.12))]">
      {/* Session Meta */}
      <div className="flex-shrink-0 space-y-3 pb-4 border-b">
        <div className="flex items-center gap-2 sm:gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push('/sessions')} className="shrink-0">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-base sm:text-lg font-semibold truncate max-w-[50vw] sm:max-w-[60vw]" title={meta?.sessionTitle ?? meta?.sessionId ?? ''}>
            {meta?.sessionTitle
              ? meta.sessionTitle
              : meta?.sessionId
                ? (meta.sessionId.length > 20 ? meta.sessionId.slice(0, 20) + '...' : meta.sessionId)
                : t('session.detail.fallbackTitle')}
          </h1>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            disabled={!meta || togglingSessionFavorite}
            aria-label={meta?.isFavorite ? t('sessions.favorite.removeSession') : t('sessions.favorite.addSession')}
            onClick={toggleSessionFavorite}
          >
            <Star className={`h-4 w-4 ${meta?.isFavorite ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground'}`} />
          </Button>
          {meta && (
            <Badge
              variant="outline"
              className={`${getToolColor(meta.sourceTool).text} ${getToolColor(meta.sourceTool).bg} border-0 font-medium`}
            >
              <ToolLogo tool={meta.sourceTool} size={16} />
              {getToolLabel(meta.sourceTool)}
            </Badge>
          )}
        </div>
        {meta && (
          <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-xs sm:text-sm text-muted-foreground ml-0 sm:ml-12 mt-2 sm:mt-0">
            {meta.deviceName && <span>{meta.deviceName}</span>}
            <span className="flex items-center gap-1">
              <MessageSquare className="h-3.5 w-3.5" />
              {t('sessions.messageCount', { count: meta.messageCount })}
            </span>
            <span className="font-mono text-xs">
              {t('session.detail.input')}: {formatTokens(meta.totalInputTokens)} · {t('session.detail.output')}: {formatTokens(meta.totalOutputTokens)} · {meta.totalCost > 0 ? `$${meta.totalCost.toFixed(4)}` : '$0.000'}
            </span>
          </div>
        )}
      </div>

      {/* Message list */}
      <div ref={scrollContainerRef} className="flex-1 overflow-auto mt-4 pr-1">
        {/* Load older indicator */}
        {loadingOlder && (
          <div className="flex justify-center py-3">
            <Skeleton className="h-6 w-24" />
          </div>
        )}
        {!loadingOlder && hasOlder && messages.length > 0 && (
          <div className="flex justify-center py-2">
            <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => void fetchOlder()}>
              {t('common.loadMore')}
            </Button>
          </div>
        )}

        {messages.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <MessageSquare className="h-12 w-12 mb-4" />
            <p>{t('session.detail.empty')}</p>
          </div>
        ) : (
          <div
            style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const msg = messages[virtualRow.index];
              if (!msg) return null;
              const isUser = msg.role === 'User';
              const isAssistant = msg.role === 'Assistant';

              return (
                <div
                  key={msg.id}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${virtualRow.start}px)` }}
                  className={`py-2 ${isUser ? 'pr-12' : 'pl-0'}`}
                >
                  {isUser ? (
                    <div className="flex gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium">
                        👤
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm break-words [overflow-wrap:anywhere]">
                          {msg.contentBlocks?.map((block, i) => (
                            <ContentBlockRenderer key={i} block={block} />
                          ))}
                        </div>
                        <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                          <span>{format(new Date(msg.rawTimestamp), 'HH:mm:ss', { locale: dateFnsLocale(locale) })}</span>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6"
                            disabled={!!togglingMessageFavorites[msg.id]}
                            aria-label={msg.isFavorite ? t('sessions.favorite.removeMessage') : t('sessions.favorite.addMessage')}
                            onClick={() => toggleMessageFavorite(msg.id, msg.isFavorite)}
                          >
                            <Star className={`h-3.5 w-3.5 ${msg.isFavorite ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground'}`} />
                          </Button>
                        </div>
                      </div>
                    </div>
                  ) : isAssistant ? (
                    <Card className="border-border/70 bg-muted/20">
                      <CardContent className="py-3">
                        <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                          {msg.usage?.model && (
                            <Badge variant="outline" className="px-1.5 py-0 text-xs">
                              <ModelLogo model={msg.usage.model} size={14} />
                              {msg.usage.model}
                            </Badge>
                          )}
                          <span>{format(new Date(msg.rawTimestamp), 'HH:mm:ss', { locale: dateFnsLocale(locale) })}</span>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="ml-auto h-6 w-6"
                            disabled={!!togglingMessageFavorites[msg.id]}
                            aria-label={msg.isFavorite ? t('sessions.favorite.removeMessage') : t('sessions.favorite.addMessage')}
                            onClick={() => toggleMessageFavorite(msg.id, msg.isFavorite)}
                          >
                            <Star className={`h-3.5 w-3.5 ${msg.isFavorite ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground'}`} />
                          </Button>
                        </div>
                        {msg.metadata && <MessageMetaBadges metadata={msg.metadata} />}
                        <div className="space-y-2 break-words [overflow-wrap:anywhere]">
                          {msg.contentBlocks?.map((block, i) => (
                            <ContentBlockRenderer key={i} block={block} />
                          ))}
                        </div>
                        {msg.usage && <TokenUsageBar usage={msg.usage} />}
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="pl-11 text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">
                      {msg.contentBlocks?.map((block, i) => (
                        <ContentBlockRenderer key={i} block={block} />
                      ))}
                      <div className="mt-1 flex items-center gap-1 text-xs">
                        <span>{format(new Date(msg.rawTimestamp), 'HH:mm:ss', { locale: dateFnsLocale(locale) })}</span>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          disabled={!!togglingMessageFavorites[msg.id]}
                          aria-label={msg.isFavorite ? t('sessions.favorite.removeMessage') : t('sessions.favorite.addMessage')}
                          onClick={() => toggleMessageFavorite(msg.id, msg.isFavorite)}
                        >
                          <Star className={`h-3.5 w-3.5 ${msg.isFavorite ? 'fill-amber-400 text-amber-500' : 'text-muted-foreground'}`} />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {loading && (
          <div className="flex justify-center py-4">
            <Skeleton className="h-6 w-24" />
          </div>
        )}
      </div>
    </div>
  );
}
