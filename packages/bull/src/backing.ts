import { EventEmitter } from 'node:events';

type JobState = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed';

export interface InMemoryJob<TData> {
    readonly id: string;
    readonly name: string;
    readonly data: TData;
    readonly opts: Readonly<Record<string, unknown>>;
    state: JobState;
    failedReason?: string;
    returnvalue?: unknown;
    processedOn?: number;
    finishedOn?: number;
    readonly delayUntil?: number;
}

export type BullProcessor<TData> = (job: InMemoryJob<TData>) => Promise<unknown>;

/** Name used for jobs added without an explicit job name (`add(data)`). */
export const DEFAULT_JOB_NAME = '__default__';

export interface AddOptions {
    readonly delay?: number;
    readonly jobId?: string | number;
    readonly [key: string]: unknown;
}

export interface JobCounts {
    readonly waiting: number;
    readonly active: number;
    readonly completed: number;
    readonly failed: number;
    readonly delayed: number;
}

/**
 * Functional in-memory Bull queue backing.
 *
 * Supports core produce/consume lifecycle: add (immediate + delayed),
 * process at concurrency 1, lifecycle events, and basic job queries.
 * No Redis, no Lua.
 */
export class InMemoryBullQueue<TData = unknown> extends EventEmitter {
    private readonly name: string;
    private readonly jobs = new Map<string, InMemoryJob<TData>>();
    private nextId = 1;
    // One processor per job name (Bull supports `process(name, handler)` for
    // multiple named handlers on the same queue). Unnamed jobs use DEFAULT_JOB_NAME.
    private readonly processors = new Map<string, BullProcessor<TData>>();
    private pumpRunning = false;
    private closed = false;
    private readonly delayTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor(name: string) {
        super();
        this.name = name;
    }

    get queueName(): string {
        return this.name;
    }

    async add(data: TData, opts?: AddOptions): Promise<InMemoryJob<TData>>;
    async add(name: string, data: TData, opts?: AddOptions): Promise<InMemoryJob<TData>>;
    async add(
        nameOrData: string | TData,
        dataOrOpts?: TData | AddOptions,
        maybeOpts?: AddOptions,
    ): Promise<InMemoryJob<TData>> {
        this.assertOpen();

        let jobName: string;
        let data: TData;
        let opts: AddOptions | undefined;

        if (typeof nameOrData === 'string') {
            jobName = nameOrData;
            data = dataOrOpts as TData;
            opts = maybeOpts;
        } else {
            jobName = DEFAULT_JOB_NAME;
            data = nameOrData;
            opts = dataOrOpts as AddOptions | undefined;
        }

        const id = opts?.jobId !== undefined ? String(opts.jobId) : this.nextAutoId();
        const delay = opts?.delay ?? 0;
        const state: JobState = delay > 0 ? 'delayed' : 'waiting';
        const delayUntil = delay > 0 ? Date.now() + delay : undefined;

        const job: InMemoryJob<TData> = {
            id,
            name: jobName,
            data,
            opts: opts ?? {},
            state,
            delayUntil,
        };

        this.jobs.set(id, job);

        if (delay > 0) {
            const timer = setTimeout(() => {
                this.delayTimers.delete(id);
                const stored = this.jobs.get(id);
                if (!stored || stored.state !== 'delayed') return;
                stored.state = 'waiting';
                void this.pump();
            }, delay);
            this.delayTimers.set(id, timer);
        } else {
            void this.pump();
        }

        return this.cloneJob(job);
    }

    process(handler: BullProcessor<TData>): void;
    process(name: string, handler: BullProcessor<TData>): void;
    process(nameOrHandler: string | BullProcessor<TData>, maybeHandler?: BullProcessor<TData>): void {
        this.assertOpen();
        const jobName = typeof nameOrHandler === 'string' ? nameOrHandler : DEFAULT_JOB_NAME;
        const handler = typeof nameOrHandler === 'string' ? maybeHandler : nameOrHandler;
        if (typeof handler !== 'function') {
            throw new Error('InMemoryBullQueue: process() requires a handler function.');
        }
        if (this.processors.has(jobName)) {
            throw new Error(`InMemoryBullQueue: process() already registered for job name '${jobName}'.`);
        }
        this.processors.set(jobName, handler);
        void this.pump();
    }

    async getJob(jobId: string | number): Promise<InMemoryJob<TData> | null> {
        const job = this.jobs.get(String(jobId));
        return job ? this.cloneJob(job) : null;
    }

    async getJobCounts(): Promise<JobCounts> {
        const counts = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
        for (const job of this.jobs.values()) {
            counts[job.state] += 1;
        }
        return counts;
    }

    async getJobs(types: ReadonlyArray<string>): Promise<ReadonlyArray<InMemoryJob<TData>>> {
        const allowed = new Set(types);
        const result: InMemoryJob<TData>[] = [];
        for (const job of this.jobs.values()) {
            if (allowed.has(job.state)) {
                result.push(this.cloneJob(job));
            }
        }
        return result;
    }

    isReady(): Promise<void> {
        this.assertOpen();
        return Promise.resolve();
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        for (const timer of this.delayTimers.values()) {
            clearTimeout(timer);
        }
        this.delayTimers.clear();
        this.removeAllListeners();
    }

    reset(): void {
        for (const timer of this.delayTimers.values()) {
            clearTimeout(timer);
        }
        this.delayTimers.clear();
        this.jobs.clear();
        this.nextId = 1;
        this.processors.clear();
        this.pumpRunning = false;
    }

    /**
     * Allocate an auto-incrementing id, skipping any id already taken by an
     * explicit `jobId` so a default add can never silently overwrite a job.
     */
    private nextAutoId(): string {
        let id = String(this.nextId++);
        while (this.jobs.has(id)) {
            id = String(this.nextId++);
        }
        return id;
    }

    private async pump(): Promise<void> {
        if (this.pumpRunning || this.closed || this.processors.size === 0) return;
        this.pumpRunning = true;
        try {
            while (!this.closed && this.processors.size > 0) {
                const next = this.pickNextWaitingJob();
                if (!next) break;

                const handler = this.processors.get(next.name);
                if (!handler) break;

                next.state = 'active';
                next.processedOn = Date.now();
                const jobSnapshot = this.cloneJob(next);
                this.emit('active', jobSnapshot);

                try {
                    const result = await handler(jobSnapshot);
                    next.state = 'completed';
                    next.returnvalue = result;
                    next.finishedOn = Date.now();
                    this.emit('completed', this.cloneJob(next), result);
                } catch (err) {
                    next.state = 'failed';
                    next.failedReason = err instanceof Error ? err.message : String(err);
                    next.finishedOn = Date.now();
                    this.emit('failed', this.cloneJob(next), err);
                }
            }
        } finally {
            this.pumpRunning = false;
        }
    }

    private pickNextWaitingJob(): InMemoryJob<TData> | undefined {
        // Only pick jobs whose name has a registered processor, mirroring Bull:
        // a named job is consumed only by `process(name, …)`.
        for (const job of this.jobs.values()) {
            if (job.state === 'waiting' && this.processors.has(job.name)) return job;
        }
        return undefined;
    }

    private cloneJob(job: InMemoryJob<TData>): InMemoryJob<TData> {
        return {
            id: job.id,
            name: job.name,
            data: job.data,
            opts: job.opts,
            state: job.state,
            failedReason: job.failedReason,
            returnvalue: job.returnvalue,
            processedOn: job.processedOn,
            finishedOn: job.finishedOn,
            delayUntil: job.delayUntil,
        };
    }

    private assertOpen(): void {
        if (this.closed) {
            throw new Error('InMemoryBullQueue is closed.');
        }
    }
}
