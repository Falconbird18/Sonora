import type {
	PdfWorkerRequest,
	PdfWorkerResponse,
	PdfWorkerResult
} from './pdfWorkerProtocol';
export function renderingCancelled() {
	return new DOMException('Rendering cancelled', 'RenderingCancelledException');
}
type Job = {
	request: PdfWorkerRequest;
	priority: number;
	cancelled: boolean;
	resolve: (result: PdfWorkerResult) => void;
	reject: (error: Error) => void;
	cleanup: () => void;
};
/** One active call per worker; queued interactive calls overtake speculative work. */
export class PdfWorkerClient {
	private worker = new Worker(new URL('./pdfium.worker.ts', import.meta.url), {
		type: 'module'
	});
	private queue: Job[] = [];
	private active?: Job;
	private sequence = 0;
	private failed?: Error;
	private timer?: ReturnType<typeof setTimeout>;
	constructor() {
		this.worker.onmessage = ({ data }: MessageEvent<PdfWorkerResponse>) => {
			const job = this.active;
			if (!job || job.request.id !== data.id) {
				data.result?.bitmap?.close();
				return;
			}
			clearTimeout(this.timer);
			this.active = undefined;
			job.cleanup();
			if (job.cancelled) data.result?.bitmap?.close();
			else if (data.error) job.reject(Error(data.error));
			else job.resolve(data.result ?? {});
			this.pump();
		};
		this.worker.onerror = (event) => {
			event.preventDefault();
			this.fail(Error(event.message || 'PDF worker failed'));
		};
		this.worker.onmessageerror = () =>
			this.fail(Error('PDF worker response could not be decoded'));
	}
	get unavailable() {
		return !!this.failed;
	}
	request(
		request: Omit<PdfWorkerRequest, 'id'>,
		priority = 0,
		signal?: AbortSignal
	): Promise<PdfWorkerResult> {
		if (this.failed) return Promise.reject(this.failed);
		if (signal?.aborted) return Promise.reject(renderingCancelled());
		return new Promise((resolve, reject) => {
			const cancel = () => {
				job.cancelled = true;
				reject(renderingCancelled());
				this.pump();
			};
			const job: Job = {
				request: { ...request, id: ++this.sequence },
				priority,
				cancelled: false,
				resolve,
				reject,
				cleanup: () => signal?.removeEventListener('abort', cancel)
			};
			signal?.addEventListener('abort', cancel, { once: true });
			this.queue.push(job);
			this.pump();
		});
	}
	cancelDocument(documentId: string) {
		for (const job of [...this.queue, ...(this.active ? [this.active] : [])]) {
			if (job.request.documentId === documentId) {
				job.cancelled = true;
				job.cleanup();
				job.reject(renderingCancelled());
			}
		}
		this.pump();
	}
	private pump() {
		if (this.active || this.failed) return;
		this.queue = this.queue.filter((job) => {
			if (job.cancelled) job.cleanup();
			return !job.cancelled;
		});
		this.queue.sort(
			(a, b) => a.priority - b.priority || a.request.id - b.request.id
		);
		const job = this.queue.shift();
		if (!job) return;
		this.active = job;
		this.timer = setTimeout(
			() => this.fail(Error('PDF worker timed out')),
			120_000
		);
		try {
			this.worker.postMessage(
				job.request,
				job.request.data ? [job.request.data] : []
			);
		} catch (error) {
			this.fail(error instanceof Error ? error : Error(String(error)));
		}
	}
	private fail(error: Error) {
		this.failed = error;
		clearTimeout(this.timer);
		this.worker.terminate();
		for (const job of [...this.queue, ...(this.active ? [this.active] : [])]) {
			job.cleanup();
			job.reject(error);
		}
		this.queue = [];
		this.active = undefined;
	}
}
