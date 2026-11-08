import { ConnectorStore, S3Objects, uploadLimits, connectorSettings } from '@zhiheng/resources';
export class ConnectorRuntime {
    private readonly objects = new S3Objects(process.env.S3_BUCKET ?? '');
    private readonly store = new ConnectorStore(process.env.DATABASE_URL, process.env.DATABASE_SCHEMA, process.env.RESOURCE_CURSOR_SECRET, this.objects, uploadLimits());
    private timer?: ReturnType<typeof setInterval>;
    private active?: Promise<void>;
    private stopped = false;
    async start() {
        if (!process.env.DATABASE_URL)
            throw new Error('Connector requires PostgreSQL');
        await this.tick();
        this.timer = setInterval(() => void this.tick(), connectorSettings().pollMs);
        console.log('Connector worker ready');
    }
    private tick() {
        if (this.active || this.stopped)
            return this.active;
        this.active = (async () => {
            try {
                await this.store.connectorTick();
            }
            catch {
                console.error('Connector synchronization deferred');
            }
        })().finally(() => { this.active = undefined; });
        return this.active;
    }
    async stop() {
        this.stopped = true;
        if (this.timer)
            clearInterval(this.timer);
        await this.active;
        await this.store.close();
        this.objects.close();
    }
}
