import { MessageQueue } from ".";

export class MessageQueueImpl implements MessageQueue {
    private queue: any[] = [];
    private processing: any[] = [];
    private failed: any[] = [];
    private batchSize: number;

    constructor(batchSize: number) {
        this.batchSize = batchSize;
    }

    async enqueue(item: any): Promise<void> {
        this.queue.push(item);
    }

    async dequeue(batchSize: number): Promise<any[]> {
        const itemsToProcess = this.queue.splice(0, batchSize);
        this.processing.push(...itemsToProcess)
        return itemsToProcess;
    }

    async requeue(items: any[]): Promise<void> {
        this.queue.push(...items);
        this.processing = this.processing.filter(item => !items.includes(item))
    }

    async getStatus(): Promise<{ pending: number; processing: number; failed: number }> {
        return {
            pending: this.queue.length,
            processing: this.processing.length,
            failed: this.failed.length,
        };
    }
}
