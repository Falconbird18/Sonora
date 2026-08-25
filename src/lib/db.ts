import Dexie, { type Table } from 'dexie';
import type { ScoreItem, AnnotationRecord, FolderSource } from './types';

export class MusicDatabase extends Dexie {
	scores!: Table<ScoreItem, string>;
	annotations!: Table<AnnotationRecord, string>;
	folders!: Table<FolderSource, string>;

	constructor() {
		super('IMSPL_MusicViewer_DB');
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
			scores: 'id, title, composer, addedAt, lastOpenedAt, favorite, collection, sourceFolderId, sourcePath, fileModifiedAt',
			annotations: 'id, scoreId, pageNum',
			folders: 'id, name, addedAt, lastSyncedAt'
		});
	}
}

export const db = new MusicDatabase();
