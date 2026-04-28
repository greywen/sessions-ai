'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TOOL_COLORS } from '@session-vault/shared';
import type { ContentBlock, TokenUsage } from '@session-vault/shared';
import { format } from 'date-fns';
import { ContentBlockRenderer } from '@/components/sessions/content-block-renderer';
import { TokenUsageBar } from '@/components/sessions/token-usage-bar';
import { ModelLogo, ToolLogo, getToolLabel } from '@/components/branding/ai-logo';
import { useI18n } from '@/lib/i18n/provider';
import { dateFnsLocale } from '@/lib/i18n/date-locale';

interface SessionMeta {
  sessionId: string;
  sessionTitle: string | null;
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
}

// DAG Rebuild:Extract Main Conversation Chain from Message List
function reconstructConversation(messages: MessageItem[]): MessageItem[] {
  if (messages.length === 0) return [];

  const messageMap = new Map<string, MessageItem>();
  for (const msg of messages) {
    messageMap.set(msg.id, msg);
  }

  // Find the last message,Trace Forward Primary Link
  const lastMessage = messages.reduce((a, b) =>
    new Date(a.rawTimestamp) > new Date(b.rawTimestamp) ? a : b,
  );

  const mainChain: MessageItem[] = [];
  const visited = new Set<string>();
  let current: MessageItem | undefined = lastMessage;

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    mainChain.unshift(current);
    current = current.parentId ? messageMap.get(current.parentId) : undefined;
  }

  // If primary link coverage is insufficient,Fallback to Time Sort
  if (mainChain.length <= messages.length * 0.5) {
    console.debug('[DAGRebuild] Low primary link coverage,Fallback Time Sort', {
      mainChainLength: mainChain.length,
      totalMessages: messages.length,
    });
    return [...messages].sort(
      (a, b) => new Date(a.rawTimestamp).getTime() - new Date(b.rawTimestamp).getTime(),
    );
  }

  console.debug('[DAGRebuild] Completed', {
    mainChainLength: mainChain.length,
    totalMessages: messages.length,
  });

  return mainChain;
}

export default function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const { t, locale } = useI18n();
  const resolvedParams = React.use(params);
  const sessionId = resolvedParams.id;

  const [meta, setMeta] = React.useState<SessionMeta | null>(null);
  const [messages, setMessages] = React.useState<MessageItem[]>([]);
  const [reconstructedMessages, setReconstructedMessages] = React.useState<MessageItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [initialLoadDone, setInitialLoadDone] = React.useState(false);

  // Get metadata
  const fetchMeta = React.useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) throw new Error('Failed to get session details');
      const json = await res.json();
      setMeta(json.data);
    } catch (error) {
      toast.error(t('session.detail.toast.metaFailed'));
      console.error('[Session details] Metadata request failed:', error);
    }
  }, [sessionId, t]);

  // Get Messages!(cursor-based)
  const fetchMessages = React.useCallback(async (cursor?: string) => {
    if (cursor) setLoadingMore(true);
    try {
      const params = new URLSearchParams();
      params.set('limit', '50');
      if (cursor) params.set('cursor', cursor);

      const res = await fetch(`/api/sessions/${sessionId}/messages?${params}`);
      if (!res.ok) throw new Error('Failed to get message list');
      const json = await res.json();

      setMessages((prev) => {
        const newMessages = cursor ? [...prev, ...json.data] : json.data;
        return newMessages;
      });
      setNextCursor(json.nextCursor);

      console.debug('[Session details] Message loading', { count: json.data.length, hasMore: !!json.nextCursor });
    } catch (error) {
      toast.error(t('session.detail.toast.messagesFailed'));
      console.error('[Session details] Message request failed:', error);
    } finally {
      setLoadingMore(false);
      setLoading(false);
      setInitialLoadDone(true);
    }
  }, [sessionId, t]);

  // Initial loading
  React.useEffect(() => {
    fetchMeta();
    fetchMessages();
  }, [fetchMeta, fetchMessages]);

  // Do this when all messages have finished loading DAG Rebuild
  React.useEffect(() => {
    if (!initialLoadDone) return;

    // If there are more messages,Load More
    if (nextCursor) {
      fetchMessages(nextCursor);
      return;
    }

    // All messages loaded,Implementation DAG Rebuild
    const chain = reconstructConversation(messages);
    setReconstructedMessages(chain);
  }, [messages, nextCursor, initialLoadDone, fetchMessages]);

  const getToolColor = (tool: string) => {
    return TOOL_COLORS[tool] ?? { text: 'text-gray-600', bg: 'bg-gray-100' };
  };

  const formatTokens = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

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
      {/* Top:Session Meta Info */}
      <div className="flex-shrink-0 space-y-3 pb-4 border-b">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push('/sessions')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-lg font-semibold truncate max-w-[60vw]" title={meta?.sessionTitle ?? meta?.sessionId ?? ''}>
            {meta?.sessionTitle
              ? meta.sessionTitle
              : meta?.sessionId
                ? meta.sessionId.length > 20
                  ? meta.sessionId.slice(0, 20) + '...'
                  : meta.sessionId
                : t('session.detail.fallbackTitle')}
          </h1>
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
          <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground ml-10">
            {meta.ownerName && <span>@{meta.ownerName}</span>}
            {meta.deviceName && <span>{meta.deviceName}</span>}
            <span className="flex items-center gap-1">
              <MessageSquare className="h-3.5 w-3.5" />
              {t('sessions.messageCount', { count: meta.messageCount })}
            </span>
            <span className="font-mono text-xs">
              {t('session.detail.input')}: {formatTokens(meta.totalInputTokens)} · {t('session.detail.output')}: {formatTokens(meta.totalOutputTokens)}
            </span>
          </div>
        )}
      </div>

      {/* Messages list */}
      <div className="flex-1 overflow-auto mt-4 pr-1">
        {reconstructedMessages.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <MessageSquare className="h-12 w-12 mb-4" />
            <p>{t('session.detail.empty')}</p>
          </div>
        ) : (
          <div className="space-y-2 pb-4">
            {reconstructedMessages.map((msg) => {
              const isUser = msg.role === 'User';
              const isAssistant = msg.role === 'Assistant';

              return (
                <div key={msg.id} className={`py-2 ${isUser ? 'pr-12' : 'pl-0'}`}>
                  {isUser ? (
                    /* Messages:Simple text style */
                    <div className="flex gap-3">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium">
                        👤
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm">
                          {msg.contentBlocks?.map((block, i) => (
                            <ContentBlockRenderer key={i} block={block} />
                          ))}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {format(new Date(msg.rawTimestamp), 'HH:mm:ss', { locale: dateFnsLocale(locale) })}
                        </div>
                      </div>
                    </div>
                  ) : isAssistant ? (
                    /* AI Reply:Rounded Cards */
                    <Card className="border-border/70 bg-muted/20">
                      <CardContent className="py-3">
                        <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                          <ToolLogo tool={msg.sourceTool} size={16} />
                          {msg.usage?.model && (
                            <Badge variant="outline" className="px-1.5 py-0 text-xs">
                              <ModelLogo model={msg.usage.model} size={14} />
                              {msg.usage.model}
                            </Badge>
                          )}
                          <span>{format(new Date(msg.rawTimestamp), 'HH:mm:ss', { locale: dateFnsLocale(locale) })}</span>
                        </div>
                        <div className="space-y-2">
                          {msg.contentBlocks?.map((block, i) => (
                            <ContentBlockRenderer key={i} block={block} />
                          ))}
                        </div>
                        {msg.usage && <TokenUsageBar usage={msg.usage} />}
                      </CardContent>
                    </Card>
                  ) : (
                    /* Other Roles:(ToolUse, ToolResult, System) */
                    <div className="pl-11 text-sm text-muted-foreground">
                      {msg.contentBlocks?.map((block, i) => (
                        <ContentBlockRenderer key={i} block={block} />
                      ))}
                      <div className="mt-1 text-xs">
                        {format(new Date(msg.rawTimestamp), 'HH:mm:ss', { locale: dateFnsLocale(locale) })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Instructions during loading */}
        {(loading || loadingMore) && (
          <div className="flex justify-center py-4">
            <Skeleton className="h-6 w-24" />
          </div>
        )}
      </div>
    </div>
  );
}
