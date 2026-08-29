export interface ScoreItem {
	id: string;
	title: string;
	composer: string;
	/** PDF bytes. On desktop this may be empty and reloaded from disk on open. */
	pdfBlob?: Blob;
	thumbnailUrl?: string;
	totalPages: number;
	addedAt: number;
	lastOpenedAt?: number;
	favorite?: boolean;
	tags?: string[];
	collection?: string;
	sourceFolderId?: string;
	sourcePath?: string;
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

export interface Point { x: number; y: number; pressure?: number; }
export interface Stroke { id?: string; tool: 'pen' | 'highlighter'; kind?: 'freehand' | 'line' | 'arrow'; color: string; width: number; points: Point[]; }
export interface SymbolStamp { id: string; scoreId?: string; pageNum?: number; symbol: string; label: string; x: number; y: number; fontSize: number; color: string; }
export interface TextNote { id: string; scoreId?: string; pageNum?: number; text: string; x: number; y: number; fontSize: number; color: string; }
export interface AnnotationRecord { id: string; scoreId: string; pageNum: number; strokes: Stroke[]; stamps: SymbolStamp[]; notes: TextNote[]; }
