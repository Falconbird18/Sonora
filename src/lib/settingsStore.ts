import { writable, derived, get } from 'svelte/store';

export type ThemePreference = 'system' | 'dark' | 'light';
export type ViewerFit = 'page' | 'width';

export type AppSettings = {
	theme: ThemePreference;
	reduceMotion: boolean;
	compactLibrary: boolean;
	/** Viewer */
	autoLayout: boolean;
	dualPages: boolean;
	keepAwake: boolean;
	defaultFit: ViewerFit;
	annotationsVisible: boolean;
	textSize: number;
};

const STORAGE_KEY = 'sonora-app-settings';

const defaults: AppSettings = {
	theme: 'system',
	reduceMotion: false,
	compactLibrary: false,
	autoLayout: true,
	dualPages: false,
	keepAwake: true,
	defaultFit: 'page',
	annotationsVisible: true,
	textSize: 18
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
			compactLibrary: !!parsed.compactLibrary,
			autoLayout: parsed.autoLayout !== false,
			dualPages: !!parsed.dualPages,
			keepAwake: parsed.keepAwake !== false,
			defaultFit: parsed.defaultFit === 'width' ? 'width' : 'page',
			annotationsVisible: parsed.annotationsVisible !== false,
			textSize:
				typeof parsed.textSize === 'number'
					? Math.max(10, Math.min(36, parsed.textSize))
					: defaults.textSize
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
		setAutoLayout(autoLayout: boolean) {
			update((s) => ({ ...s, autoLayout }));
		},
		setDualPages(dualPages: boolean) {
			update((s) => ({ ...s, dualPages }));
		},
		setKeepAwake(keepAwake: boolean) {
			update((s) => ({ ...s, keepAwake }));
		},
		setDefaultFit(defaultFit: ViewerFit) {
			update((s) => ({ ...s, defaultFit }));
		},
		setAnnotationsVisible(annotationsVisible: boolean) {
			update((s) => ({ ...s, annotationsVisible }));
		},
		setTextSize(textSize: number) {
			update((s) => ({
				...s,
				textSize: Math.max(10, Math.min(36, textSize))
			}));
		},
		patch(partial: Partial<AppSettings>) {
			update((s) => ({ ...s, ...partial }));
		},
		reset() {
			set({ ...defaults });
		}
	};
}

export const settings = createSettingsStore();

export const resolvedTheme = derived(settings, ($s) => resolveTheme($s.theme));
