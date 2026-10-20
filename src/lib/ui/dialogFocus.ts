/** Keep keyboard navigation inside dialogs and restore the invoking control. */
export function dialogFocus(node: HTMLElement) {
	const previous =
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: null;
	const candidates = () =>
		[
			...node.querySelectorAll<HTMLElement>(
				'button, a[href], input, select, textarea, [tabindex="0"]'
			)
		].filter(
			(el) => !el.hasAttribute('disabled') && el.getClientRects().length
		);
	const frame = requestAnimationFrame(() => (candidates()[0] ?? node).focus({preventScroll:true}));
	const onKey = (event: KeyboardEvent) => {
		if (event.key !== 'Tab') return;
		const elements = candidates();
		const first = elements[0],
			last = elements.at(-1);
		if (!first) {
			event.preventDefault();
			node.focus();
			return;
		}
		if (
			event.shiftKey &&
			(document.activeElement === first ||
				!node.contains(document.activeElement))
		) {
			event.preventDefault();
			last?.focus();
		} else if (
			!event.shiftKey &&
			(document.activeElement === last ||
				!node.contains(document.activeElement))
		) {
			event.preventDefault();
			first.focus();
		}
	};
	node.addEventListener('keydown', onKey);
	return {
		destroy() {
			cancelAnimationFrame(frame);
			node.removeEventListener('keydown', onKey);
			if (previous?.isConnected) previous.focus();
		}
	};
}
