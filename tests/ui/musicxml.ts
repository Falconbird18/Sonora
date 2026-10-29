import { mount } from 'svelte';
import { openScoreSource, scoreFormat } from '../../src/lib/scoreRenderer';
import { prepareMusicXml } from '../../src/lib/musicXmlImport';
import ScoreViewer from '../../src/lib/ScoreViewer.svelte';
import { makePdfFixture } from './pdfFixture';
import xml from '../fixtures/engraving.musicxml?raw';
import JSZip from 'jszip';
import '../../src/lib/styles/tokens.css';
import '../../src/app.css';
if (!import.meta.env.DEV) throw Error('Development-only fixture');
const result = document.querySelector('#result')!;
function assert(value: unknown, message: string) {
	if (!value) throw Error(message);
}
try {
	const blob = new Blob([xml], {
		type: 'application/vnd.recordare.musicxml+xml'
	});
	assert(scoreFormat({ blob }) === 'musicxml', 'Recognize MusicXML MIME type');
	assert(
		scoreFormat({ nativePath: '/scores/score.MXL' }) === 'musicxml',
		'Recognize compressed MusicXML'
	);
	const opened = await openScoreSource({ blob });
	assert(
		opened.document.numPages === 2,
		`Expected two engraved pages, got ${opened.document.numPages}`
	);
	for (const index of [0, 1]) {
		const page = await opened.document.renderPage(index, { width: 560 });
		assert(page.blob.size > 2000, 'Notation page must not be empty');
		const bitmap = await createImageBitmap(page.blob);
		const canvas = document.createElement('canvas');
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		const ctx = canvas.getContext('2d')!;
		ctx.drawImage(bitmap, 0, 0);
		bitmap.close();
		const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		let ink = 0;
		for (let p = 0; p < pixels.length; p += 4)
			if (pixels[p] < 150 && pixels[p + 3] > 0) ink++;
		assert(ink > 300, 'MusicXML rendering must contain visible notation');
	}
	const controller = new AbortController();
	controller.abort();
	let aborted = false;
	try {
		await opened.document.renderPage(0, { signal: controller.signal });
	} catch {
		aborted = true;
	}
	assert(aborted, 'Cancelled rendering must reject');
	await opened.document.cleanup();
	let closed = false;
	try {
		await opened.document.renderPage(0);
	} catch {
		closed = true;
	}
	assert(closed, 'Closed score must release page snapshots');
	const pdf = await openScoreSource({
		blob: new Blob([new Uint8Array(await makePdfFixture('vector', 1))], {
			type: 'application/pdf'
		})
	});
	assert(
		pdf.document.numPages === 1,
		'The same dispatcher must still render PDFs'
	);
	assert(
		(await pdf.document.renderPage(0, { width: 400 })).blob.size > 2000,
		'PDF raster must remain valid'
	);
	await pdf.document.cleanup();
	const archive = new JSZip();
	archive.file(
		'META-INF/container.xml',
		'<container><rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>'
	);
	archive.file('score.musicxml', xml);
	const compressed = await archive.generateAsync({
		type: 'blob',
		compression: 'DEFLATE'
	});
	const mxlScore = await prepareMusicXml(compressed, 'song.mxl');
	assert(
		mxlScore.fileExtension === 'mxl' && mxlScore.totalPages === 2,
		'Compressed MusicXML must engrave and keep its format'
	);
	const score = await prepareMusicXml(blob, 'fixture.musicxml');
	assert(
		score.totalPages === 2 && score.title.includes('two pages'),
		'Import must preserve metadata and pagination'
	);
	assert(
		(await score.pdfBlob!.text()) === xml,
		'Import must preserve original MusicXML bytes'
	);
	const display = new URLSearchParams(location.search).has('real')
		? await prepareMusicXml(
				await (await fetch('/sonora-omr-smoke.local')).blob(),
				'Dichterliebe.musicxml'
			)
		: score;
	mount(ScoreViewer, {
		target: document.querySelector('#app')!,
		props: { score: display, onClose: () => {} }
	});
	result.textContent =
		'PASS: real MusicXML engraving, two pages, visible notation, cancellation, cleanup, PDF dispatch and lossless import';
} catch (error) {
	result.textContent = `FAIL: ${error}`;
	throw error;
}
