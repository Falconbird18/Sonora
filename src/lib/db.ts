import Dexie, { type Table } from 'dexie';
import type { ScoreItem, AnnotationRecord } from './types';

export class MusicDatabase extends Dexie {
  scores!: Table<ScoreItem, string>;
  annotations!: Table<AnnotationRecord, string>;

  constructor() {
    super('IMSPL_MusicViewer_DB');
    this.version(1).stores({
      scores: 'id, title, composer, addedAt',
      annotations: 'id, scoreId, pageNum'
    });
  }
}

export const db = new MusicDatabase();
