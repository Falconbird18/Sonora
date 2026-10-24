import { findComposer } from './composerDatabase';
import type { ComposerDisplay } from './settingsStore';

/** Formatting changes presentation only; canonical metadata remains intact. */
export function formatComposer(
	name: string,
	style: ComposerDisplay = 'full'
): string {
	if (!name || name === 'Unknown Composer') return name || 'Unknown Composer';
	const record = findComposer(name);
	const canonical =
		record?.name ??
		(name.includes(',')
			? name.split(',').slice(1).join(' ').trim() +
				' ' +
				name.split(',')[0].trim()
			: name);
	const words = canonical.trim().split(/\s+/);
	// Preserve surname particles, including van/von/de, when formatting unknown records.
	let surnameStart = words.length - 1;
	while (
		surnameStart > 0 &&
		/^(van|von|de|del|della|da|di|du|le|la)$/i.test(words[surnameStart - 1])
	)
		surnameStart--;
	const knownSurname = record?.aliases
		.filter((alias) => !alias.includes(',') && canonical.endsWith(alias))
		.sort((a, b) => a.length - b.length)[0];
	const surname = name.includes(',')
		? name.split(',')[0].trim()
		: knownSurname || words.slice(surnameStart).join(' ');
	const given = name.includes(',')
		? name.split(',').slice(1).join(' ').trim()
		: canonical.slice(0, canonical.length - surname.length).trim();
	if (style === 'surname') return surname;
	if (style === 'surname-first')
		return given ? `${surname}, ${given}` : surname;
	if (style === 'initials')
		return `${given
			.split(/\s+/)
			.filter(Boolean)
			.map((p) =>
				/^(van|von|de|del|da|di|du|le|la)$/i.test(p) ? p : p[0] + '.'
			)
			.join(' ')} ${surname}`.trim();
	return canonical;
}
