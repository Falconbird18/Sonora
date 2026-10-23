import { invoke } from '@tauri-apps/api/core';
import { COMPOSERS, findComposer } from './composerDatabase';
import { openPdf, closePdf } from './pdfUtils';
import {
	searchImslp,
	getWorkScores,
	parseWorkTitle,
	imslpAvailable
} from './imslp';
import type { ScoreItem } from './types';
import { formatComposer } from './composerDisplay';
const composerTerms = (c: (typeof COMPOSERS)[number]) => [
	c.name,
	formatComposer(c.name, 'surname-first'),
	...c.aliases
];

const normalizeImportText = (s: string) =>
	s
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

let indexedComposers: typeof COMPOSERS | undefined;
let importTerms: Array<{
	composer: (typeof COMPOSERS)[number];
	terms: string[];
}> = [];
function getImportTerms() {
	if (indexedComposers !== COMPOSERS) {
		indexedComposers = COMPOSERS;
		importTerms = COMPOSERS.map((composer) => ({
			composer,
			terms: composerTerms(composer).map(normalizeImportText)
		}));
	}
	return importTerms;
}

export function suggestFilename(filename: string, text = '') {
	let title = filename
		.replace(/\.pdf$/i, '')
		.replace(/(?:IMSLP|PMLP)\s*\d+(?:[-_ ]+\d+)?/gi, '')
		.replace(/[-_–—]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const normalizedTitle = ` ${normalizeImportText(title)} `;
	const candidates = getImportTerms()
		.filter(({ terms }) =>
			terms.some(
				(term) => term.length > 3 && normalizedTitle.includes(` ${term} `)
			)
		)
		.map(({ composer }) => composer);
	const composer = candidates.length === 1 ? candidates[0] : undefined;
	if (composer) {
		for (const alias of composerTerms(composer).sort(
			(a, b) => b.length - a.length
		)) {
			const pattern = alias
				.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
				.replace(/[\s,_-]+/g, '[\\s,_-]+');
			title = title.replace(
				new RegExp(`(^|[^\\p{L}])${pattern}(?=$|[^\\p{L}])`, 'giu'),
				' '
			);
		}
		title = title
			.replace(/\s+/g, ' ')
			.replace(/^[\s,;:()\[\]-]+|[\s,;:()\[\]-]+$/g, '')
			.trim();
	}
	const normalizedText = !composer
		? ` ${normalizeImportText(text.slice(0, 6000))} `
		: '';
	const textMatches = !composer
		? getImportTerms()
				.filter(({ terms }) =>
					terms.some(
						(term) => term.length > 6 && normalizedText.includes(` ${term} `)
					)
				)
				.map(({ composer }) => composer)
		: [];
	const recognized =
		composer || (textMatches.length === 1 ? textMatches[0] : undefined);
	return {
		title:
			title ||
			text
				.split(/[\r\n]+/)
				.map((t) => t.trim())
				.find(
					(t) =>
						t.length > 4 &&
						t.length < 140 &&
						!/imslp|copyright|all rights|www\.|https?:/i.test(t) &&
						(!recognized ||
							!composerTerms(recognized).some(
								(a) => normalizeImportText(a) === normalizeImportText(t)
							))
				) ||
			'Untitled score',
		composer: recognized?.name || 'Unknown Composer',
		composerId: recognized?.id,
		composerPeriod: recognized?.period,
		composerCountry: recognized?.country,
		composerBirthPlace: recognized?.birthPlace,
		composerBirthYear: recognized?.birthYear,
		composerDeathYear: recognized?.deathYear,
		catalogue: title.match(
			/\b(?:Op\.?|BWV|K\.?|KV|D\.?|Hob\.)\s*\d+(?:\s*(?:No\.?|n[°º])\s*\d+)?/i
		)?.[0],
		key: title.match(
			/\b[A-G](?:[ #♯♭]| flat| sharp)?\s+(?:major|minor)\b/i
		)?.[0],
		tags: recognized?.period ? recognized.period.split(/\s*\/\s*/) : []
	};
}
export type ImportCandidate = {
	file: File;
	score: ScoreItem;
	selected: boolean;
	status: string;
	error?: string;
	duplicate?: boolean;
	matches?: import('./imslp').ImslpSearchHit[];
};
export async function analyzeImport(
	file: File,
	online: boolean,
	ocr = false
): Promise<ImportCandidate> {
	let text = '',
		ocrStatus = '',
		totalPages = 1,
		thumbnailUrl: string | undefined,
		opened: Awaited<ReturnType<typeof openPdf>> | undefined;
	try {
		opened = await openPdf(file, { background: true });
		totalPages = opened.document.numPages;
		for (let p = 1; p <= Math.min(2, totalPages); p++) {
			const page = await opened.document.getPage(p);
			text +=
				(await page.getTextContent()).items.map((i) => i.str).join('\n') + '\n';
			page.cleanup();
		}
		try {
			const first = await opened.document.getPage(1),
				viewport = first.getViewport({ scale: 1 }),
				preview = await opened.document.renderPage(0, {
					scale: Math.min(0.35, 160 / viewport.width)
				});
			thumbnailUrl = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(preview.blob);
			});
		} catch {
			/* A missing preview must not block importing a readable score. */
		}
		if (!text.trim() && ocr && imslpAvailable()) {
			try {
				const page = await opened.document.getPage(1),
					viewport = page.getViewport({ scale: 1 }),
					scale = Math.min(2, 1800 / Math.max(viewport.width, viewport.height));
				const image = await opened.document.renderPage(0, { scale });
				text = await invoke<string>('ocr_score_page', {
					image: Array.from(new Uint8Array(await image.blob.arrayBuffer()))
				});
				ocrStatus = text.trim() ? ' · local OCR' : ' · OCR found no text';
			} catch (e) {
				ocrStatus = ` · ${String(e)}`;
			}
		}
	} catch (error) {
		return {
			file,
			score: {
				id: crypto.randomUUID(),
				...suggestFilename(file.name),
				totalPages,
				addedAt: Date.now()
			},
			selected: false,
			status: 'Unreadable PDF',
			error: String(error)
		};
	} finally {
		await closePdf(opened);
	}
	const suggestion = suggestFilename(file.name, text);
	let score: ScoreItem = {
		id: crypto.randomUUID(),
		...suggestion,
		pdfBlob: file,
		thumbnailUrl,
		thumbnailVersion: thumbnailUrl ? 2 : undefined,
		totalPages,
		addedAt: Date.now(),
		fileSize: file.size
	};
	let matches: import('./imslp').ImslpSearchHit[] = [];
	let status =
		(text.trim()
			? ocrStatus
				? 'Filename + local OCR'
				: 'Filename + local PDF text'
			: 'Filename only · scanned PDF') + (text.trim() ? '' : ocrStatus);
	if (online && imslpAvailable())
		try {
			const hits = (matches = await searchImslp(
				`${suggestion.title} ${suggestion.composer === 'Unknown Composer' ? '' : suggestion.composer}`,
				6
			));
			const normalize = (s: string) =>
				s
					.toLowerCase()
					.replace(/[^\p{L}\p{N}]+/gu, '')
					.trim();
			const exactMatches = hits.filter((h) => {
				const parsed = parseWorkTitle(h.title);
				return (
					normalize(parsed.title) === normalize(suggestion.title) &&
					(suggestion.composer === 'Unknown Composer' ||
						findComposer(parsed.composer)?.id === suggestion.composerId)
				);
			});
			const match = exactMatches.length === 1 ? exactMatches[0] : undefined;
			if (match) {
				const parsed = parseWorkTitle(match.title),
					details = await getWorkScores(match.title),
					c = findComposer(parsed.composer);
				score = {
					...score,
					title: details.metadata.title || parsed.title,
					workTitle: parsed.title,
					workId: `imslp:${match.title}`,
					composer: c?.name || parsed.composer,
					composerId: c?.id,
					composerPeriod: c?.period,
					composerCountry: c?.country,
					composerBirthPlace: c?.birthPlace,
					composerBirthYear: c?.birthYear,
					composerDeathYear: c?.deathYear,
					catalogue: details.metadata.catalogue,
					key: details.metadata.key,
					instruments: details.metadata.instruments,
					compositionDate: details.metadata.compositionDate,
					movements: details.metadata.movements,
					imslpPage: match.title,
					tags: [
						...new Set([
							...suggestion.tags,
							...[details.metadata.period].filter((x): x is string => !!x)
						])
					]
				};
				status = 'IMSLP match · review suggested metadata';
			} else status += ' · no exact IMSLP match';
		} catch {
			status += ' · IMSLP unavailable';
		}
	return { file, score, selected: true, status, matches };
}
export async function fileFingerprint(file: File) {
	return Array.from(
		new Uint8Array(
			await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
		)
	)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

export async function applyImslpMatch(
	candidate: ImportCandidate,
	pageTitle: string
) {
	const parsed = parseWorkTitle(pageTitle),
		details = await getWorkScores(pageTitle),
		composer = findComposer(parsed.composer);
	candidate.score = {
		...candidate.score,
		title: details.metadata.title || parsed.title,
		workTitle: parsed.title,
		workId: `imslp:${pageTitle}`,
		composer: composer?.name || parsed.composer,
		composerId: composer?.id,
		composerPeriod: composer?.period,
		composerCountry: composer?.country,
		composerBirthPlace: composer?.birthPlace,
		composerBirthYear: composer?.birthYear,
		composerDeathYear: composer?.deathYear,
		catalogue: details.metadata.catalogue,
		key: details.metadata.key,
		instruments: details.metadata.instruments,
		compositionDate: details.metadata.compositionDate,
		movements: details.metadata.movements,
		imslpPage: pageTitle,
		tags: [
			...new Set([
				...(candidate.score.tags || []),
				...[details.metadata.period].filter((t): t is string => !!t)
			])
		]
	};
	candidate.status = 'IMSLP metadata applied · review before importing';
}
