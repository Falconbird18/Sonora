import { invoke } from '@tauri-apps/api/core';

export interface OmrOptions {
	dpi: number;
	first_page: number;
	last_page: number | null;
	lyrics: boolean;
	languages: string;
	tessdata_path: string;
	lyrics_above: boolean;
	small_notes: boolean;
	tremolos: boolean;
	fingerings: boolean;
}
export interface OmrReview {
	parts: number;
	measures: number;
	notes: number;
	rests: number;
	lyrics: number;
	articulations: number;
	dynamics: number;
	slurs: number;
	ties: number;
	warnings: string[];
}
export interface OmrJob {
	id: string;
	score_id: string;
	status: 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
	created_at: number;
	source: string;
	engine: string;
	options: OmrOptions;
	artifacts: {
		name: string;
		kind: 'musicxml' | 'project';
		review: OmrReview | null;
	}[];
	warnings: string[];
	error: string | null;
	log_tail: string;
}

export const defaultOmrOptions = (): OmrOptions => ({
	dpi: 400,
	first_page: 1,
	last_page: null,
	lyrics: true,
	languages: 'eng',
	tessdata_path: '',
	lyrics_above: false,
	small_notes: false,
	tremolos: true,
	fingerings: false
});

// Jobs belong to the native app, so hiding a panel or leaving a score doesn't
// destroy work. Reopening the panel reconnects to the persisted result.
export const latestOmr = (scoreId: string) =>
	invoke<OmrJob | null>('latest_omr', { scoreId });
export const omrStatus = (id: string) => invoke<OmrJob>('omr_status', { id });
export const startOmr = (
	scoreId: string,
	inputPath: string | null,
	enginePath: string,
	options: OmrOptions
) => invoke<OmrJob>('start_omr', { scoreId, inputPath, enginePath, options });
export const cancelOmr = (id: string) => invoke<void>('cancel_omr', { id });
export const pickOmrEngine = () => invoke<string | null>('pick_omr_engine');
export const pickOmrTessdata = () => invoke<string | null>('pick_omr_tessdata');
export const saveOmrArtifact = (id: string, index: number) =>
	invoke<boolean>('save_omr_artifact', { id, index });
