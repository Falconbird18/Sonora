import { writable, derived, get } from 'svelte/store';

export type ThemePreference = 'system' | 'dark' | 'light';

export type AppSettings = {
	theme: ThemePreference;
	reduceMotion: boolean;
	compactLibrary: boolean;
};

const STORAGE_KEY = 'sonora-app-settings';

const defaults: AppSettings = {
	theme: 'system',
	reduceMotion: false,
	compactLibrary: false
};

function load(): AppSettings {
	if (typeof localStorage === 'undefined') return { ...defaults };
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...defaults };
		const parsed = JSON.parse(raw) as Partial<AppSettings>;
		return {
			theme: ['system', 'dark', 'light'].includes(parsed.theme as string)
				? (parsed.theme as ThemePreference)
				: defaults.theme,
			reduceMotion: !!parsed.reduceMotion,
			compactLibrary: !!parsed.compactLibrary
		};
	} catch {
		return { ...defaults };
	}
}

function systemIsDark(): boolean {
	if (typeof window === 'undefined' || !window.matchMedia) return true;
	return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolveTheme(pref: ThemePreference): 'dark' | 'light' {
	if (pref === 'system') return systemIsDark() ? 'dark' : 'light';
	return pref;
}

function applyDom(settings: AppSettings) {
	if (typeof document === 'undefined') return;
	const resolved = resolveTheme(settings.theme);
	document.documentElement.dataset.theme = resolved;
	document.documentElement.style.colorScheme = resolved;
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) {
		meta.setAttribute('content', resolved === 'light' ? '#f4f3f8' : '#0c0c0e');
	}
	document.documentElement.classList.toggle('reduce-motion', settings.reduceMotion);
}

function createSettingsStore() {
	const initial = load();
	const { subscribe, set, update } = writable<AppSettings>(initial);

	if (typeof window !== 'undefined') {
		applyDom(initial);
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const onChange = () => {
			const current = get({ subscribe });
			if (current.theme === 'system') applyDom(current);
		};
		mq.addEventListener?.('change', onChange);
	}

	subscribe((value) => {
		if (typeof localStorage !== 'undefined') {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
		}
		applyDom(value);
	});

	return {
		subscribe,
		set,
		update,
		setTheme(theme: ThemePreference) {
			update((s) => ({ ...s, theme }));
		},
		setReduceMotion(reduceMotion: boolean) {
			update((s) => ({ ...s, reduceMotion }));
		},
		setCompactLibrary(compactLibrary: boolean) {
			update((s) => ({ ...s, compactLibrary }));
		},
		reset() {
			set({ ...defaults });
		}
	};
}

export const settings = createSettingsStore();

export const resolvedTheme = derived(settings, ($s) => resolveTheme($s.theme));
