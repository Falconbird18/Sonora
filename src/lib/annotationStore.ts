import { db } from './db';
import type { AnnotationRecord, Stroke, SymbolStamp, TextNote } from './types';

type AnnotationState = Pick<AnnotationRecord, 'strokes' | 'stamps' | 'notes'>;

// Serialize writes per annotation record. A fast sequence of edits must never
// allow an older IndexedDB write to finish after a newer one.
const queues = new Map<string, Promise<void>>();
const pending = new Set<Promise<void>>();

export function requestPersistentStorage() {
	if (typeof navigator === 'undefined' || !navigator.storage?.persist) return;
	void navigator.storage.persist().then((persistent) => {
		if (persistent) console.info('Sonora annotation storage is persistent.');
	});
}

export async function loadAnnotations(scoreId: string) {
	return db.annotations.where('scoreId').equals(scoreId).toArray();
}

export function saveAnnotation(
	scoreId: string,
	pageNum: number,
	state: AnnotationState
): Promise<void> {
	const id = `${scoreId}:${pageNum}`;
	const record: AnnotationRecord = {
		id,
		scoreId,
		pageNum,
		strokes: structuredClone(state.strokes),
		stamps: structuredClone(state.stamps),
		notes: structuredClone(state.notes)
	};

	const previous = queues.get(id) ?? Promise.resolve();
	const write = previous
		.catch(() => undefined)
		.then(() => db.annotations.put(record).then(() => undefined));
	queues.set(id, write);
	pending.add(write);
	void write.finally(() => {
		pending.delete(write);
		if (queues.get(id) === write) queues.delete(id);
	});
	return write;
}

export async function flushAnnotationSaves() {
	while (pending.size) await Promise.allSettled([...pending]);
}

export function annotationState(record: AnnotationRecord): AnnotationState {
	return {
		strokes: record.strokes || [],
		stamps: record.stamps || [],
		notes: record.notes || []
	};
}
