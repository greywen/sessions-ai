import pino from 'pino';

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');
const silent = process.env.LOG_SILENT === 'true';

// CAUTION:Not Use pino transport(pino-pretty),and one of the reasons that Next.js Turbopack In the environment
// thread-stream worker Path resolution error.Direct output in development environment JSON Journal.
export const logger = pino({
  level: silent ? 'silent' : level,
});
