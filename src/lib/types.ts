export interface ScoreItem {
	id: string;
	title: string;
	composer: string;
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
	id?: string;
	tool: 'pen' | 'highlighter';
	kind?: 'freehand' | 'line' | 'arrow';
	color: string;
	width: number;
	points: Point[];
}
export interface SymbolStamp {
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
