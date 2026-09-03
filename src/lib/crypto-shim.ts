/**
 * Browser-safe stand-in for Node's `crypto` module.
 * @embedpdf/models imports `crypto`; Vite externalizes it for browsers,
 * which leaves a broken module and can prevent the app from starting.
 * Map only the APIs embedpdf is likely to touch onto Web Crypto.
 */

const webCrypto = globalThis.crypto;

export function randomBytes(size: number): Uint8Array {
	const buffer = new Uint8Array(size);
	webCrypto.getRandomValues(buffer);
	return buffer;
}

export function randomUUID(): string {
	if (typeof webCrypto.randomUUID === 'function') {
		return webCrypto.randomUUID();
	}
	const bytes = randomBytes(16);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getRandomValues<T extends ArrayBufferView>(array: T): T {
	return webCrypto.getRandomValues(array);
}

export const subtle = webCrypto.subtle;

const api = {
	randomBytes,
	randomUUID,
	getRandomValues,
	subtle,
	webcrypto: webCrypto
};

export default api;
