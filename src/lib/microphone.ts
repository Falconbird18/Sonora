export function microphoneErrorMessage(error: unknown): string {
	const name =
		error && typeof error === 'object' && 'name' in error ? error.name : '';
	switch (name) {
		case 'NotAllowedError':
		case 'PermissionDeniedError':
			return 'Microphone access was blocked. Try Enable microphone again and allow access in the permission prompt. If it stays blocked, check microphone permissions in your system or browser settings.';
		case 'NotFoundError':
		case 'DevicesNotFoundError':
			return 'No microphone was found. Connect or enable a microphone, then try again.';
		case 'NotReadableError':
		case 'TrackStartError':
			return 'The microphone could not be opened. Check your system’s audio input and close other apps using the microphone, then try again.';
		case 'SecurityError':
			return 'Microphone access is disabled in this context. Use the desktop app or open Sonora over HTTPS or localhost.';
		default:
			return error instanceof Error
				? `Microphone unavailable: ${error.message}`
				: 'Microphone unavailable. Check your audio input and try again.';
	}
}
