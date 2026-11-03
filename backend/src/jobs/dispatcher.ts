import { logger } from '../utils/logger';

/** Runs `job` every `intervalMs`, never overlapping itself. Returns a stop function. */
export function startDispatcher(job: () => Promise<unknown>, intervalMs: number): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await job();
    } catch (err) {
      logger.error({ err: { message: (err as Error).message } }, 'Dispatcher run failed');
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
