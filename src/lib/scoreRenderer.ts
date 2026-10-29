/** Both PDFium and MusicXML engraving expose the viewer's fixed-page contract. */
import { openPdfSource, wrapDocument, type PdfSource } from './pdfUtils';
import type { PdfOpenOptions } from './pdfRenderer';
import type { ScoreItem } from './types';
import { isTauri } from './paths';

export type ScoreSource = PdfSource & { format?: ScoreItem['format'] };
export function scoreFormat(source: ScoreSource): 'pdf' | 'musicxml' {
	if (source.format) return source.format;
	if (
		/\.(musicxml|xml|mxl)(?:$|[?#])/i.test(
			source.nativePath || source.url || ''
		)
	)
		return 'musicxml';
	if (/musicxml|application\/xml|text\/xml/.test(source.blob?.type || ''))
		return 'musicxml';
	if (
		typeof File !== 'undefined' &&
		source.blob instanceof File &&
		/\.(musicxml|xml|mxl)$/i.test(source.blob.name)
	)
		return 'musicxml';
	return 'pdf';
}
export async function openScoreSource(
	source: ScoreSource,
	options?: PdfOpenOptions
) {
	if (scoreFormat(source) === 'pdf') return openPdfSource(source, options);
	let blob = source.blob;
	if (!blob && source.nativePath && isTauri()) {
		const { invoke } = await import('@tauri-apps/api/core');
		blob = new Blob([
			await invoke<ArrayBuffer>('read_score_file_binary', {
				path: source.nativePath
			})
		]);
	}
	if (!blob && source.url) {
		const response = await fetch(source.url);
		if (!response.ok)
			throw Error(`Could not open MusicXML (${response.status})`);
		blob = await response.blob();
	}
	if (!blob?.size) throw Error('MusicXML data is missing.');
	const { openMusicXml } = await import('./musicXmlRenderer');
	return wrapDocument(await openMusicXml(blob));
}
