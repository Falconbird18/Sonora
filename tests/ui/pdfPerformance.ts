import { pdfiumRenderer as legacy } from './pdfLegacyRenderer';
import { pdfiumRenderer as worker } from '../../src/lib/pdfiumRenderer';
import type {
	PdfDocumentRenderer,
	PdfRenderer
} from '../../src/lib/pdfRenderer';
import { makePdfFixture } from './pdfFixture';
if (!import.meta.env.DEV) throw Error('Development-only benchmark');
const output = document.querySelector('#result')!;
const canvas = document.querySelector<HTMLCanvasElement>('#preview')!;
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
const rows: Record<string, string | number>[] = [];
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 10));
async function measure(
	kind: string,
	renderer: string,
	name: string,
	work: (index: number) => Promise<void>
) {
	await work(0);
	const samples: number[] = [];
	let maxUiGapMs = 0;
	let last = performance.now();
	const timer = setInterval(() => {
		const now = performance.now();
		maxUiGapMs = Math.max(maxUiGapMs, now - last);
		last = now;
	}, 8);
	try {
		for (let i = 0; i < 7; i++) {
			await delay();
			const start = performance.now();
			await work(i + 1);
			samples.push(performance.now() - start);
		}
		await delay();
	} finally {
		clearInterval(timer);
	}
	samples.sort((a, b) => a - b);
	rows.push({
		kind,
		renderer,
		name,
		medianMs: +samples[3].toFixed(2),
		p95Ms: +samples[6].toFixed(2),
		maxUiGapMs: +maxUiGapMs.toFixed(2)
	});
	output.textContent = JSON.stringify({ status: 'RUNNING', rows }, null, 2);
}
async function draw(
	document: PdfDocumentRenderer,
	page: number,
	scale: number
) {
	const bitmap = document.renderBitmap
		? await document.renderBitmap(page, { scale })
		: await createImageBitmap(
				(await document.renderPage(page, { scale })).blob
			);
	try {
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		ctx.drawImage(bitmap, 0, 0);
	} finally {
		bitmap.close();
	}
}
try {
	for (const kind of ['vector', 'scan'] as const) {
		const bytes = await makePdfFixture(kind);
		let baseline: Uint8ClampedArray | undefined;
		for (const [name, renderer] of [
			['legacy', legacy],
			['worker', worker]
		] as Array<[string, PdfRenderer]>) {
			let start = performance.now();
			const document = await renderer.open(bytes, `benchmark-${kind}`);
			rows.push({
				kind,
				renderer: name,
				name: 'open',
				ms: +(performance.now() - start).toFixed(2)
			});
			try {
				await measure(kind, name, 'pageRasterAndDraw', (index) =>
					draw(document, index % document.pageCount, 1.7)
				);
				await draw(document, 0, 0.5);
				const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
				if (baseline) {
					if (
						pixels.length !== baseline.length ||
						pixels.some((value, index) => value !== baseline![index])
					)
						throw Error(`${kind}: rendered pixels differ from baseline`);
				} else baseline = new Uint8ClampedArray(pixels);
				await measure(
					kind,
					name,
					'thumbnailOpenRenderEncodeClose',
					async (index) => {
						const thumbnail = await renderer.open(bytes, `thumbnail-${index}`, {
							background: true
						});
						try {
							const result = await thumbnail.renderPage(0, {
								scale: 160 / 612
							});
							if (!result.blob.size) throw Error('Empty thumbnail');
						} finally {
							await thumbnail.close();
						}
					}
				);
				if (name === 'worker') {
					const blobDocument = await renderer.openBlob!(
						new Blob([bytes]),
						'blob-fixture'
					);
					try {
						if (blobDocument.pageCount !== document.pageCount)
							throw Error('Blob page count changed');
						const bitmap = await blobDocument.renderBitmap!(0, { scale: 0.5 });
						if (!bitmap.width || !bitmap.height)
							throw Error('Blob document raster is empty');
						bitmap.close();
					} finally {
						await blobDocument.close();
					}

					const controller = new AbortController();
					controller.abort();
					try {
						await document.renderBitmap!(0, { signal: controller.signal });
						throw Error('Aborted render unexpectedly completed');
					} catch (error) {
						if (
							!(error instanceof Error) ||
							error.name !== 'RenderingCancelledException'
						)
							throw error;
					}
				}
			} finally {
				await document.close();
			}
		}
	}
	output.textContent = JSON.stringify(
		{
			status: 'PASS',
			userAgent: navigator.userAgent,
			checks: [
				'identical vector and scanned pixels',
				'independent background documents',
				'cancellation',
				'worker Blob reading'
			],
			rows
		},
		null,
		2
	);
} catch (error) {
	output.textContent = JSON.stringify(
		{ status: 'FAIL', error: String(error), rows },
		null,
		2
	);
	throw error;
}
