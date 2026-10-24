/** Round upward so nearby zoom/resize values share a raster without undersampling. */
export function scoreRasterScale(
	fitScale: number,
	zoom: number,
	safeScale: number
) {
	return Math.max(
		0.18,
		Math.min(2.4, Math.ceil(fitScale * zoom * 8) / 8, safeScale)
	);
}
/** Layout size is deliberately excluded: it affects CSS placement, not PDF pixels. */
export function scoreRasterKey(page: number, renderScale: number, dpr: number) {
	return `${page}@${Math.round(renderScale * dpr * 1000)}`;
}
