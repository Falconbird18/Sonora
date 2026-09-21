/**
 * Hands-free page turning via webcam + MediaPipe Face Landmarker.
 *
 * Detects:
 *  - Head yaw (left / right turn) for previous / next page
 *  - Deliberate blink / wink (optional)
 *
 * Design: each gesture is one-shot. After a page turn fires, the user must
 * return to a neutral pose before another turn can trigger. This prevents
 * continuous auto-advancing while the head stays slightly turned.
 *
 * All processing is on-device. Camera is only started when enabled.
 * Tries GPU (WebGL) first, then falls back to CPU if the GPU service
 * cannot be created (common in some Tauri / WebView environments).
 */

import {
	FilesetResolver,
	FaceLandmarker,
	type FaceLandmarkerResult
} from '@mediapipe/tasks-vision';

export type GestureAction = 'next' | 'previous';

export type HandsFreeOptions = {
	/** Master enable */
	enabled: boolean;
	/** Detect head yaw left/right */
	headYaw: boolean;
	/** Detect deliberate blinks (both eyes) as next */
	blinkNext: boolean;
	/** Detect left wink as previous, right wink as next */
	wink: boolean;
	/** Yaw angle (degrees) required to trigger. Lower = more sensitive. */
	yawThreshold: number;
	/** How long the head must stay past threshold (ms) before firing */
	holdMs: number;
	/** Cooldown after a successful page turn (ms) */
	cooldownMs: number;
	/** Minimum time between consecutive frames we process (ms) */
	processIntervalMs: number;
};

export const DEFAULT_HANDS_FREE: HandsFreeOptions = {
	enabled: false,
	headYaw: true,
	blinkNext: false,
	wink: false,
	yawThreshold: 22,
	holdMs: 320,
	cooldownMs: 1200,
	processIntervalMs: 80
};

type Listener = (action: GestureAction) => void;

// Landmark indices (MediaPipe Face Mesh topology)
const LEFT_EYE_UPPER = 159;
const LEFT_EYE_LOWER = 145;
const RIGHT_EYE_UPPER = 386;
const RIGHT_EYE_LOWER = 374;
const NOSE_TIP = 1;
const LEFT_CHEEK = 234;
const RIGHT_CHEEK = 454;

/** Fraction of yawThreshold treated as "neutral" (hysteresis). */
const NEUTRAL_FRACTION = 0.45;

function eyeAspectRatio(
	landmarks: { x: number; y: number; z: number }[],
	upper: number,
	lower: number
): number {
	const u = landmarks[upper];
	const l = landmarks[lower];
	if (!u || !l) return 1;
	return Math.abs(u.y - l.y);
}

function estimateYaw(landmarks: { x: number; y: number; z: number }[]): number {
	const nose = landmarks[NOSE_TIP];
	const left = landmarks[LEFT_CHEEK];
	const right = landmarks[RIGHT_CHEEK];
	if (!nose || !left || !right) return 0;
	const leftDist = Math.hypot(nose.x - left.x, nose.y - left.y);
	const rightDist = Math.hypot(nose.x - right.x, nose.y - right.y);
	// Positive = turned left (user's left when facing camera),
	// negative = turned right.
	const ratio = (rightDist - leftDist) / ((leftDist + rightDist) / 2 || 1);
	return ratio * 45;
}

async function createLandmarker(
	vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
	delegate: 'GPU' | 'CPU'
): Promise<FaceLandmarker> {
	return FaceLandmarker.createFromOptions(vision, {
		baseOptions: {
			modelAssetPath:
				'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
			delegate
		},
		runningMode: 'VIDEO',
		numFaces: 1,
		outputFaceBlendshapes: true,
		outputFacialTransformationMatrixes: false
	});
}

export class HandsFreeController {
	private landmarker: FaceLandmarker | null = null;
	private video: HTMLVideoElement | null = null;
	private stream: MediaStream | null = null;
	private raf = 0;
	private lastProcess = 0;
	private lastActionAt = 0;
	/** Current accumulating hold (must stay past threshold for holdMs). */
	private holdStart: { action: GestureAction; at: number } | null = null;
	/**
	 * After a successful fire we lock until the user returns to neutral.
	 * This is the main fix for repeated page turns while the head stays turned.
	 */
	private armed = true;
	private listeners = new Set<Listener>();
	private options: HandsFreeOptions = { ...DEFAULT_HANDS_FREE };
	private status: 'idle' | 'starting' | 'running' | 'error' = 'idle';
	private errorMessage = '';
	private lastBlinkOpen = true;
	private blinkClosedAt = 0;
	private usingCpu = false;
	/** Simple exponential moving average for yaw stability. */
	private yawEma = 0;
	private yawEmaInitialized = false;

	on(listener: Listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	getStatus() {
		return {
			status: this.status,
			error: this.errorMessage,
			delegate: this.usingCpu ? 'CPU' : 'GPU'
		};
	}

	updateOptions(partial: Partial<HandsFreeOptions>) {
		this.options = { ...this.options, ...partial };
		if (!this.options.enabled) {
			void this.stop();
		} else if (this.status === 'idle' || this.status === 'error') {
			void this.start();
		}
	}

	async start() {
		if (this.status === 'starting' || this.status === 'running') return;
		if (!this.options.enabled) return;

		this.status = 'starting';
		this.errorMessage = '';
		this.armed = true;
		this.holdStart = null;
		this.yawEmaInitialized = false;

		try {
			if (!this.landmarker) {
				const vision = await FilesetResolver.forVisionTasks(
					'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm'
				);

				try {
					this.landmarker = await createLandmarker(vision, 'GPU');
					this.usingCpu = false;
				} catch (gpuErr) {
					console.warn(
						'[HandsFree] GPU delegate failed, falling back to CPU:',
						gpuErr
					);
					this.landmarker = await createLandmarker(vision, 'CPU');
					this.usingCpu = true;
				}
			}

			this.stream = await navigator.mediaDevices.getUserMedia({
				video: {
					facingMode: 'user',
					width: { ideal: 640 },
					height: { ideal: 480 }
				},
				audio: false
			});

			this.video = document.createElement('video');
			this.video.srcObject = this.stream;
			this.video.playsInline = true;
			this.video.muted = true;
			await this.video.play();

			this.status = 'running';
			this.lastProcess = 0;
			this.loop();
		} catch (err) {
			this.status = 'error';
			this.errorMessage =
				err instanceof Error ? err.message : 'Failed to start camera / MediaPipe';
			console.error('[HandsFree]', err);
			if (this.landmarker) {
				try {
					this.landmarker.close();
				} catch {
					/* ignore */
				}
				this.landmarker = null;
			}
			await this.cleanup();
		}
	}

	async stop() {
		cancelAnimationFrame(this.raf);
		this.raf = 0;
		await this.cleanup();
		this.status = 'idle';
		this.holdStart = null;
		this.armed = true;
	}

	private async cleanup() {
		if (this.stream) {
			for (const track of this.stream.getTracks()) track.stop();
			this.stream = null;
		}
		if (this.video) {
			this.video.srcObject = null;
			this.video = null;
		}
	}

	private loop = () => {
		this.raf = requestAnimationFrame(this.loop);
		if (!this.landmarker || !this.video || this.video.readyState < 2) return;

		const now = performance.now();
		if (now - this.lastProcess < this.options.processIntervalMs) return;
		this.lastProcess = now;

		try {
			const result = this.landmarker.detectForVideo(this.video, now);
			this.handleResult(result, now);
		} catch (e) {
			console.warn('[HandsFree] detectForVideo failed', e);
		}
	};

	private handleResult(result: FaceLandmarkerResult, now: number) {
		if (!result.faceLandmarks?.length) {
			this.holdStart = null;
			// No face → treat as neutral so we can re-arm
			this.armed = true;
			return;
		}

		const landmarks = result.faceLandmarks[0];
		const blendshapes = result.faceBlendshapes?.[0]?.categories ?? [];

		const getScore = (name: string) =>
			blendshapes.find((c) => c.categoryName === name)?.score ?? 0;

		const eyeBlinkLeft = getScore('eyeBlinkLeft');
		const eyeBlinkRight = getScore('eyeBlinkRight');

		const leftEar = eyeAspectRatio(landmarks, LEFT_EYE_UPPER, LEFT_EYE_LOWER);
		const rightEar = eyeAspectRatio(landmarks, RIGHT_EYE_UPPER, RIGHT_EYE_LOWER);

		const leftClosed = eyeBlinkLeft > 0.55 || leftEar < 0.016;
		const rightClosed = eyeBlinkRight > 0.55 || rightEar < 0.016;

		// --- Smoothed yaw ---
		const rawYaw = estimateYaw(landmarks);
		if (!this.yawEmaInitialized) {
			this.yawEma = rawYaw;
			this.yawEmaInitialized = true;
		} else {
			this.yawEma = this.yawEma * 0.65 + rawYaw * 0.35;
		}
		const yaw = this.yawEma;
		const threshold = this.options.yawThreshold;
		const neutralBand = threshold * NEUTRAL_FRACTION;

		const yawLeft = yaw > threshold;
		const yawRight = yaw < -threshold;
		const yawNeutral = Math.abs(yaw) < neutralBand;

		const bothClosed = leftClosed && rightClosed;
		const onlyLeft = leftClosed && !rightClosed;
		const onlyRight = rightClosed && !leftClosed;
		const eyesOpen = !leftClosed && !rightClosed;

		// Re-arm only when fully neutral (head centered + both eyes open).
		// This is what stops the "keeps turning right" loop.
		if (yawNeutral && eyesOpen) {
			this.armed = true;
			this.holdStart = null;
		}

		// While disarmed, ignore gesture accumulation entirely.
		if (!this.armed) {
			this.holdStart = null;
			return;
		}

		// --- Blink (both eyes) ---
		if (this.options.blinkNext) {
			if (bothClosed && this.lastBlinkOpen) {
				this.blinkClosedAt = now;
			}
			if (!bothClosed && !this.lastBlinkOpen && this.blinkClosedAt) {
				const duration = now - this.blinkClosedAt;
				if (duration >= 80 && duration <= 400) {
					this.fire('next', now);
				}
				this.blinkClosedAt = 0;
			}
			this.lastBlinkOpen = !bothClosed;
		}

		// --- Wink ---
		if (this.options.wink) {
			if (onlyLeft) this.tryHold('previous', now);
			else if (onlyRight) this.tryHold('next', now);
			else if (!bothClosed) {
				// Eyes not in a wink state — cancel wink hold only
				if (
					this.holdStart &&
					!yawLeft &&
					!yawRight
				) {
					this.holdStart = null;
				}
			}
		}

		// --- Head yaw ---
		if (this.options.headYaw) {
			if (yawLeft) {
				this.tryHold('previous', now);
			} else if (yawRight) {
				this.tryHold('next', now);
			} else if (!onlyLeft && !onlyRight) {
				// Not holding a yaw gesture anymore
				this.holdStart = null;
			}
		}
	}

	private tryHold(action: GestureAction, now: number) {
		if (!this.armed) return;
		if (now - this.lastActionAt < this.options.cooldownMs) return;

		if (!this.holdStart || this.holdStart.action !== action) {
			this.holdStart = { action, at: now };
			return;
		}

		if (now - this.holdStart.at >= this.options.holdMs) {
			this.fire(action, now);
		}
	}

	private fire(action: GestureAction, now: number) {
		if (!this.armed) return;
		if (now - this.lastActionAt < this.options.cooldownMs) return;

		this.lastActionAt = now;
		this.holdStart = null;
		// Disarm until the user returns to neutral (centered head + open eyes).
		this.armed = false;

		for (const l of this.listeners) {
			try {
				l(action);
			} catch (e) {
				console.error('[HandsFree] listener error', e);
			}
		}
	}

	dispose() {
		void this.stop();
		if (this.landmarker) {
			this.landmarker.close();
			this.landmarker = null;
		}
		this.listeners.clear();
	}
}

/** Singleton for the app lifetime */
export const handsFree = new HandsFreeController();
