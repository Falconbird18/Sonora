export interface ScoreItem {
	id: string;
	contentHash?: string;
	annotationLayers?: AnnotationLayer[];
	workId?: string;
	workTitle?: string;
	edition?: string;
	publisher?: string;
	editor?: string;
	arranger?: string;
	catalogue?: string;
	key?: string;
	compositionDate?: string;
	movements?: string;
	imslpPage?: string;
	metadataEdited?: boolean;
	title: string;
	composer: string;
	/** Stable composer database record, when the composer is recognized. */
	composerId?: string | null;
	composerPeriod?: string;
	composerCountry?: string;
	composerBirthPlace?: string;
	composerBirthYear?: number;
	composerDeathYear?: number;
	/** Year composed (optional). */
	year?: number | null;
	/** e.g. "String Quartet", "Orchestra", "Solo". */
	ensemble?: string;
	/** Free text or comma-separated instrument list. */
	instruments?: string;
	/** PDF bytes (browser mode / rare fallback). Prefer pdfUrl on desktop. */
	pdfBlob?: Blob;
	/** Asset-protocol or blob URL for zero-copy open on desktop. */
	pdfUrl?: string;
	thumbnailUrl?: string;
	thumbnailVersion?: number;
	totalPages: number;
	addedAt: number;
	lastOpenedAt?: number;
	favorite?: boolean;
	tags?: string[];
	collection?: string;
	sourceFolderId?: string;
	sourcePath?: string;
	/** Absolute native path when available (desktop). */
	nativePath?: string;
	fileSize?: number;
	fileModifiedAt?: number;
}

export interface FolderSource {
	id: string;
	name: string;
	handle?: FileSystemDirectoryHandle;
	nativePath?: string;
	addedAt: number;
	lastSyncedAt?: number;
	autoSync: boolean;
}

export interface Point {
	x: number;
	y: number;
	pressure?: number;
}
export interface Stroke {
	layerId?: string;
	id?: string;
	tool: 'pen' | 'highlighter';
	kind?: 'freehand' | 'line' | 'arrow';
	color: string;
	width: number;
	points: Point[];
}
export interface SymbolStamp {
	layerId?: string;
	id: string;
	scoreId?: string;
	pageNum?: number;
	symbol: string;
	label: string;
	x: number;
	y: number;
	fontSize: number;
	color: string;
}
export interface TextNote {
	layerId?: string;
	id: string;
	scoreId?: string;
	pageNum?: number;
	text: string;
	x: number;
	y: number;
	fontSize: number;
	color: string;
}
export interface AnnotationRecord {
	id: string;
	scoreId: string;
	pageNum: number;
	strokes: Stroke[];
	stamps: SymbolStamp[];
	notes: TextNote[];
}

export interface ScoreMetadataUpdate {
	workTitle?: string;
	edition?: string;
	publisher?: string;
	editor?: string;
	arranger?: string;
	catalogue?: string;
	key?: string;
	compositionDate?: string;
	movements?: string;

	title: string;
	composer: string;
	composerId?: string | null;
	composerPeriod?: string;
	composerCountry?: string;
	composerBirthPlace?: string;
	composerBirthYear?: number;
	composerDeathYear?: number;
	year?: number | null;
	ensemble?: string;
	instruments?: string;
	tags: string[];
}

/** Entry ids allow a concert program to repeat a score without losing its order. */
export interface ListEntry {
	id: string;
	scoreId: string;
}
export interface ScoreList {
	id: string;
	name: string;
	description: string;
	entries: ListEntry[];
	createdAt: number;
	updatedAt: number;
}

export interface AnnotationLayer {
	id: string;
	name: string;
	visible: boolean;
}
