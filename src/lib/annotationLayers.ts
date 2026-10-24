import type { AnnotationLayer } from './types';
export function markLayer(mark: { layerId?: string }) {
	return mark.layerId || 'default';
}
export function replaceLayerMarks<T extends { layerId?: string }>(
	current: T[],
	replacement: T[],
	layerId: string
): T[] {
	return [
		...current.filter((mark) => markLayer(mark) !== layerId),
		...replacement.filter((mark) => markLayer(mark) === layerId)
	];
}
export function recoverLayers(
	saved: AnnotationLayer[] | undefined,
	marks: { layerId?: string }[]
): AnnotationLayer[] {
	const result = (
		saved?.length
			? saved
			: [{ id: 'default', name: 'Annotations', visible: true }]
	).map((l) => ({ ...l }));
	for (const mark of marks) {
		const id = markLayer(mark);
		if (!result.some((l) => l.id === id))
			result.push({
				id,
				name: id === 'default' ? 'Annotations' : 'Recovered layer',
				visible: true
			});
	}
	return result;
}
