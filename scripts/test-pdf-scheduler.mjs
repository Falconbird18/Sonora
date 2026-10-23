import assert from 'node:assert/strict';
import { createServer } from 'vite';
class WorkerFixture {
	static instances = [];
	sent = [];
	terminated = false;
	constructor() {
		WorkerFixture.instances.push(this);
	}
	postMessage(request) {
		this.sent.push(request);
	}
	terminate() {
		this.terminated = true;
	}
	reply(result = {}) {
		this.onmessage({ data: { id: this.sent.at(-1).id, result } });
	}
}
const previous = globalThis.Worker;
globalThis.Worker = WorkerFixture;
const server = await createServer({
	server: { middlewareMode: true, hmr: false, ws: false },
	appType: 'custom'
});
try {
	const { scoreRasterScale, scoreRasterKey } = await server.ssrLoadModule(
		'/src/lib/scoreRaster.ts'
	);
	const nearby = Array.from({ length: 100 }, (_, i) =>
		scoreRasterScale(0.76 + i / 10000, 1, 3)
	);
	assert.equal(
		new Set(nearby).size,
		1,
		'100 nearby viewport sizes should reuse one raster'
	);
	assert.ok(
		nearby.every((scale, i) => scale >= 0.76 + i / 10000),
		'Raster buckets must retain requested sharpness'
	);
	assert.equal(
		scoreRasterScale(2, 4, 1.4),
		1.4,
		'Respect pixel budget at high zoom'
	);
	assert.notEqual(scoreRasterKey(1, 1, 1), scoreRasterKey(2, 1, 1));
	assert.equal(
		scoreRasterKey(1, 1, 2),
		scoreRasterKey(1, 2, 1),
		'Equivalent physical resolutions can share pixels'
	);
	const { PdfWorkerClient } = await server.ssrLoadModule(
		'/src/lib/pdfWorkerClient.ts'
	);
	const client = new PdfWorkerClient();
	const worker = WorkerFixture.instances.at(-1);
	const busy = client.request({ method: 'warm' });
	const speculative = client.request(
		{ method: 'bitmap', documentId: 'prefetch' },
		1
	);
	const interactive = client.request({
		method: 'bitmap',
		documentId: 'visible'
	});
	worker.reply();
	await busy;
	assert.equal(worker.sent.at(-1).documentId, 'visible');
	worker.reply();
	await interactive;
	assert.equal(worker.sent.at(-1).documentId, 'prefetch');
	worker.reply();
	await speculative;
	const blocker = client.request({ method: 'warm' });
	const abort = new AbortController();
	const cancelled = assert.rejects(
		client.request(
			{ method: 'bitmap', documentId: 'cancelled' },
			1,
			abort.signal
		),
		{ name: 'RenderingCancelledException' }
	);
	abort.abort();
	await cancelled;
	worker.reply();
	await blocker;
	assert.ok(!worker.sent.some((request) => request.documentId === 'cancelled'));
	const activeAbort = new AbortController();
	const late = assert.rejects(
		client.request(
			{ method: 'bitmap', documentId: 'late' },
			0,
			activeAbort.signal
		),
		{ name: 'RenderingCancelledException' }
	);
	activeAbort.abort();
	await late;
	let released = 0;
	worker.reply({
		bitmap: {
			close() {
				released++;
			}
		}
	});
	assert.equal(released, 1);
	const closing = assert.rejects(
		client.request({ method: 'text', documentId: 'closed' }),
		{ name: 'RenderingCancelledException' }
	);
	client.cancelDocument('closed');
	await closing;
	worker.reply();
	const failure = assert.rejects(client.request({ method: 'warm' }), /crashed/);
	worker.onerror({ message: 'crashed', preventDefault() {} });
	await failure;
	assert.equal(client.unavailable, true);
	assert.equal(worker.terminated, true);
	await assert.rejects(client.request({ method: 'warm' }), /crashed/);
	console.log(
		'PDF scheduler checks passed: foreground priority, queued cancellation, late bitmap cleanup, document cancellation, worker failure.'
	);
} finally {
	await server.close();
	globalThis.Worker = previous;
}
