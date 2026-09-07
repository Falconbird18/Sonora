import { COMPOSERS, findComposer, getComposerPortraitPath, type ComposerRecord } from './composerDatabase';

export const COMPOSER_KEYS = COMPOSERS.map((composer) => composer.id) as readonly string[];
export type ComposerKey = string;
export type ComposerData = ComposerRecord & { portraitUrl: string };

export function resolveComposerKey(name: string): ComposerKey | null {
	return findComposer(name)?.id ?? null;
}

export function getComposerData(name: string): ComposerData | null {
	const composer = findComposer(name);
	if (!composer) return null;
	return { ...composer, portraitUrl: getComposerPortraitPath(composer) };
}

export function getComposerPortrait(name: string): string {
	return getComposerData(name)?.portraitUrl ?? '';
}
