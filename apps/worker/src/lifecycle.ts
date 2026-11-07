import { LifecycleStore, S3Objects, uploadLimits, lifecyclePolicy } from '@zhiheng/resources';
export class LifecycleRuntime {
    private readonly objects = new S3Objects(process.env.S3_BUCKET ?? '');
    private readonly store = new LifecycleStore(process.env.DATABASE_URL, process.env.DATABASE_SCHEMA, process.env.RESOURCE_CURSOR_SECRET, this.objects, uploadLimits());
    private timer?: ReturnType<typeof setInterval>;
    private active?: Promise<void>;
    private stopped = false;
    async start() { if (!process.env.DATABASE_URL)
        throw new Error('Lifecycle requires PostgreSQL'); await this.tick(); this.timer = setInterval(() => void this.tick(), lifecyclePolicy().pollMs); console.log('Lifecycle worker ready'); }
    private tick() { if (this.active || this.stopped)
        return this.active; this.active = (async () => { try {
        await this.store.cleanupTick();
        await this.store.purgeExpiredHistory();
    }
    catch {
        console.error('Lifecycle maintenance deferred');
    } })().finally(() => { this.active = undefined; }); return this.active; }
    async stop() { this.stopped = true; if (this.timer)
        clearInterval(this.timer); await this.active; await this.store.close(); this.objects.close(); }
}
