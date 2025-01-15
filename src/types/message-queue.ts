import { MatrixEvent, Room } from 'matrix-js-sdk';

export type QueueItemType = 'message' | 'retry_decrypt' | 'error' | 'retry';

export interface QueueItem {
    event: MatrixEvent;
    room: Room;
    type: QueueItemType;
    retryCount?: number;
    error?: string;
    timestamp?: string;
    content?: any;
}

export interface MessageQueue {
    enqueue(item: QueueItem): Promise<void>;
    dequeue(batchSize: number): Promise<QueueItem[]>;
    requeue(items: QueueItem[]): Promise<void>;
    getPending(type: QueueItemType): Promise<QueueItem[]>;
    getStatus(): Promise<{
        pending: number;
        processing: number;
        failed: number;
        retrying: number;
    }>;
    clear(): Promise<void>;
    size(): Promise<number>;
}

export class MessageQueueImpl implements MessageQueue {
    private queue: Map<string, QueueItem> = new Map();
    private processing: Map<string, QueueItem> = new Map();
    private failed: Map<string, QueueItem> = new Map();
    private retrying: Map<string, QueueItem> = new Map();
    private readonly batchSize: number;
    private readonly maxRetries: number = 3;
    private readonly retryDelays: number[] = [1000, 5000, 30000]; // increasing delays between retries

    constructor(batchSize: number) {
        this.batchSize = batchSize;
    }

    private getItemKey(item: QueueItem): string {
        return `${item.event.getId()}_${item.type}`;
    }

    async enqueue(item: QueueItem): Promise<void> {
        const key = this.getItemKey(item);

        // If the item is already being processed, don't add it again
        if (this.processing.has(key)) return;

        // Add timestamp if not present
        if (!item.timestamp) {
            item.timestamp = new Date().toISOString();
        }

        // Handle retry items
        if (item.type === 'retry') {
            const retryCount = (item.retryCount || 0) + 1;
            if (retryCount <= this.maxRetries) {
                item.retryCount = retryCount;
                this.retrying.set(key, item);

                // Schedule retry with exponential backoff
                const delay = this.retryDelays[Math.min(retryCount - 1, this.retryDelays.length - 1)];
                setTimeout(() => {
                    this.retrying.delete(key);
                    this.queue.set(key, item);
                }, delay);
            } else {
                // Move to failed queue if max retries exceeded
                this.failed.set(key, item);
            }
            return;
        }

        this.queue.set(key, item);
    }

    async dequeue(batchSize: number): Promise<QueueItem[]> {
        const items: QueueItem[] = [];
        const keys = Array.from(this.queue.keys());

        // Prioritize non-retry items
        const priorityItems = keys
            .filter(key => !this.queue.get(key)?.retryCount)
            .slice(0, batchSize);

        // Fill remaining batch with retry items if needed
        const retryItems = keys
            .filter(key => this.queue.get(key)?.retryCount)
            .slice(0, batchSize - priorityItems.length);

        const batchKeys = [...priorityItems, ...retryItems];

        for (const key of batchKeys) {
            const item = this.queue.get(key);
            if (item) {
                items.push(item);
                this.queue.delete(key);
                this.processing.set(key, item);
            }
        }

        return items;
    }

    async requeue(items: QueueItem[]): Promise<void> {
        for (const item of items) {
            const key = this.getItemKey(item);
            this.processing.delete(key);

            // Add as retry item
            await this.enqueue({
                ...item,
                type: 'retry',
                retryCount: (item.retryCount || 0)
            });
        }
    }

    async getPending(type: QueueItemType): Promise<QueueItem[]> {
        const items: QueueItem[] = [];

        // Get items from queue
        for (const [_, item] of this.queue) {
            if (item.type === type) {
                items.push(item);
            }
        }

        // Get items from processing
        for (const [_, item] of this.processing) {
            if (item.type === type) {
                items.push(item);
            }
        }

        // Get items from retrying
        for (const [_, item] of this.retrying) {
            if (item.type === type) {
                items.push(item);
            }
        }

        return items;
    }

    async getStatus(): Promise<{
        pending: number;
        processing: number;
        failed: number;
        retrying: number;
    }> {
        return {
            pending: this.queue.size,
            processing: this.processing.size,
            failed: this.failed.size,
            retrying: this.retrying.size
        };
    }

    async clear(): Promise<void> {
        this.queue.clear();
        this.processing.clear();
        this.failed.clear();
        this.retrying.clear();
    }

    async size(): Promise<number> {
        return this.queue.size + this.processing.size + this.retrying.size;
    }

    // Additional utility methods

    async clearFailed(): Promise<void> {
        this.failed.clear();
    }

    async retryFailed(): Promise<number> {
        const failedItems = Array.from(this.failed.values());
        for (const item of failedItems) {
            // Reset retry count and requeue
            item.retryCount = 0;
            await this.enqueue({
                ...item,
                type: 'retry'
            });
        }
        this.failed.clear();
        return failedItems.length;
    }

    async getFailedItems(): Promise<QueueItem[]> {
        return Array.from(this.failed.values());
    }

    async removeFromProcessing(key: string): Promise<void> {
        this.processing.delete(key);
    }

    async isProcessing(key: string): Promise<boolean> {
        return this.processing.has(key);
    }

    async getProcessingItems(): Promise<QueueItem[]> {
        return Array.from(this.processing.values());
    }
}
