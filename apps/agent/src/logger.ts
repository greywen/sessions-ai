import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
});

/** Mask key (show first 8 characters only). */
export function maskKey(key: string | undefined | null): string {
  if (!key) return '<empty>';
  return key.length > 8 ? `${key.slice(0, 8)}***` : `${key}***`;
}
