import { randomUUID } from 'node:crypto';
import { Queue, QueueEvents } from 'bullmq';
import { redisConfig } from '@zhiheng/config';
import { DEVELOPMENT_JOB, DEVELOPMENT_QUEUE } from '@zhiheng/contracts';

async function smoke() {
  const connection = { ...redisConfig(), maxRetriesPerRequest: 1 };
  const queue = new Queue(DEVELOPMENT_QUEUE, { connection });
  const events = new QueueEvents(DEVELOPMENT_QUEUE, { connection: redisConfig() });
  queue.on('error', () => {});
  events.on('error', () => {});
  // Bound connection failures as well as waiting for a worker.
  const deadline = setTimeout(() => {
    console.error('Queue smoke timed out; check Redis and worker');
    process.exit(1);
  }, 20000);
  try {
    await events.waitUntilReady();
    const nonce = randomUUID();
    const job = await queue.add(DEVELOPMENT_JOB, { nonce }, {
      removeOnComplete: true, removeOnFail: true,
    });
    const result = await job.waitUntilFinished(events, 10000);
    if (result?.nonce !== nonce) throw new Error('Queue round trip mismatch');
    console.log('Queue round trip passed');
  } finally {
    await events.close();
    await queue.close();
    clearTimeout(deadline);
  }
}
smoke().catch(() => {
  console.error('Queue smoke failed; check Redis and worker');
  process.exitCode = 1;
});
