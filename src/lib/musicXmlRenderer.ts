import type { PdfDocumentRenderer, PdfRenderOptions } from './pdfRenderer';
import { MAX_CANVAS_PIXELS } from './pdfUtils';

const abort = () => new DOMException('Rendering cancelled', 'AbortError');

/** Engrave once into fixed pages so annotations don't move when the window resizes. */
export async function openMusicXml(blob: Blob): Promise<PdfDocumentRenderer> {
	if (blob.size > 64 * 1024 * 1024)
		throw Error('MusicXML is too large (64 MB maximum).');
	const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay');
	const host = document.createElement('div');
	host.style.cssText =
		'position:fixed;left:-20000px;top:0;width:1120px;visibility:hidden;pointer-events:none;background:white;';
	host.setAttribute('aria-hidden', 'true');
	document.body.append(host);
	const engine = new OpenSheetMusicDisplay(host, {
		backend: 'svg',
		autoResize: false,
		pageFormat: 'A4 P',
		drawTitle: true,
		drawComposer: true,
		disableCursor: true,
		newPageFromXML: true,
		newSystemFromXML: true
	});
	try {
		// Decode XML explicitly; OSMD also accepts the binary string of an MXL ZIP.
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const compressed = bytes[0] === 0x50 && bytes[1] === 0x4b;
		let input: string;
		if (compressed) {
			const chunks: string[] = [];
			for (let i = 0; i < bytes.length; i += 32768)
				chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
			input = chunks.join('');
		} else {
			input = new TextDecoder().decode(bytes);
			const parsed = new DOMParser().parseFromString(input, 'application/xml');
			if (
				parsed.querySelector('parsererror') ||
				!['score-partwise', 'score-timewise'].includes(
					parsed.documentElement.localName
				)
			)
				throw Error('Choose a valid MusicXML score.');
		}
		await engine.load(input);
		engine.render();
		const pages = [...host.querySelectorAll('svg')].filter(
			(svg) => !svg.closest('defs')
		);
		if (!pages.length) throw Error('The MusicXML engraver produced no pages.');
		const snapshots = pages.map((svg) => {
			const width =
				svg.viewBox.baseVal.width ||
				parseFloat(svg.getAttribute('width') || '') ||
				1120;
			const height =
				svg.viewBox.baseVal.height ||
				parseFloat(svg.getAttribute('height') || '') ||
				(width * 297) / 210;
			svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
			return {
				width,
				height,
				xml: new XMLSerializer().serializeToString(svg),
				text: svg.textContent || ''
			};
		});
		let closed = false;
		return {
			pageCount: snapshots.length,
			pages: snapshots.map(({ width, height }, index) => ({
				index,
				width,
				height
			})),
			async getPageText(index) {
				return snapshots[index]?.text || '';
			},
			async renderPage(index: number, options: PdfRenderOptions = {}) {
				if (closed) throw Error('This score has been closed.');
				if (options.signal?.aborted) throw abort();
				const page = snapshots[index];
				if (!page) throw Error(`Score page ${index + 1} does not exist.`);
				const requested =
					options.scale ||
					(options.width
						? options.width / page.width
						: options.height
							? options.height / page.height
							: 1);
				const scale = Math.min(
					Math.max(0.05, requested),
					Math.sqrt(MAX_CANVAS_PIXELS / (page.width * page.height))
				);
				const canvas = document.createElement('canvas');
				canvas.width = Math.max(1, Math.ceil(page.width * scale));
				canvas.height = Math.max(1, Math.ceil(page.height * scale));
				const context = canvas.getContext('2d');
				if (!context) throw Error('The score canvas could not be created.');
				const url = URL.createObjectURL(
					new Blob([page.xml], { type: 'image/svg+xml' })
				);
				try {
					const image = new Image();
					image.src = url;
					await image.decode();
					if (closed || options.signal?.aborted) throw abort();
					context.fillStyle = '#fff';
					context.fillRect(0, 0, canvas.width, canvas.height);
					context.drawImage(image, 0, 0, canvas.width, canvas.height);
					const rendered = await new Promise<Blob>((resolve, reject) =>
						canvas.toBlob(
							(value) =>
								value
									? resolve(value)
									: reject(Error('Could not render this MusicXML page.')),
							options.imageType || 'image/png'
						)
					);
					if (closed || options.signal?.aborted) throw abort();
					return { blob: rendered, width: canvas.width, height: canvas.height };
				} finally {
					URL.revokeObjectURL(url);
					canvas.width = canvas.height = 0;
				}
			},
			async close() {
				closed = true;
				snapshots.length = 0;
			}
		};
	} finally {
		engine.clear();
		host.remove();
	}
}
