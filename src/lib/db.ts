import Dexie, { type Table } from 'dexie';
import type { ScoreItem, AnnotationRecord, FolderSource } from './types';

/**
 * Indexed fields only — year / ensemble / instruments / tags are still stored
 * on each ScoreItem object, but are not IndexedDB indexes (optional / sparse
 * values are a common source of upgrade failures).
 */
const SCORES_INDEX =
	'id, title, composer, addedAt, lastOpenedAt, favorite, collection, sourceFolderId, sourcePath, fileModifiedAt';
const ANNOTATIONS_INDEX = 'id, scoreId, pageNum';
const FOLDERS_INDEX = 'id, name, addedAt, lastSyncedAt';

export class MusicDatabase extends Dexie {
	scores!: Table<ScoreItem, string>;
	annotations!: Table<AnnotationRecord, string>;
	folders!: Table<FolderSource, string>;

	constructor() {
		super('Sonora_MusicViewer_DB');

		this.version(1).stores({
			scores: 'id, title, composer, addedAt',
			annotations: 'id, scoreId, pageNum'
		});

		this.version(2).stores({
			scores: 'id, title, composer, addedAt, sourceFolderId, sourcePath',
			annotations: 'id, scoreId, pageNum',
			folders: 'id, name, addedAt'
		});

		this.version(3).stores({
			scores: SCORES_INDEX,
			annotations: ANNOTATIONS_INDEX,
			folders: FOLDERS_INDEX
		});

		// Brief experiment with parentId — removed in v5.
		this.version(4).stores({
			scores: SCORES_INDEX,
			annotations: ANNOTATIONS_INDEX,
			folders: 'id, name, addedAt, lastSyncedAt, parentId'
		});

		this.version(5).stores({
			scores: SCORES_INDEX,
			annotations: ANNOTATIONS_INDEX,
			folders: FOLDERS_INDEX
		});

		// v6 previously tried to index year/ensemble; keep the declaration so
		// browsers that already opened at 6 can still open, then recover in v7.
		this.version(6).stores({
			scores:
				'id, title, composer, addedAt, lastOpenedAt, favorite, collection, sourceFolderId, sourcePath, fileModifiedAt, year, ensemble',
			annotations: ANNOTATIONS_INDEX,
			folders: FOLDERS_INDEX
		});

		// Drop sparse indexes; metadata fields remain as plain object properties.
		this.version(7).stores({
			scores: SCORES_INDEX,
			annotations: ANNOTATIONS_INDEX,
			folders: FOLDERS_INDEX
		});
	}
}

export const db = new MusicDatabase();
