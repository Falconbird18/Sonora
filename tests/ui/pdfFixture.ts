/** Deterministic PDF fixtures: vector notation and JPEG-scanned notation, no network. */
export async function makePdfFixture(
	kind: 'vector' | 'scan',
	pageCount = 24
): Promise<Uint8Array> {
	const encoder = new TextEncoder();
	const objects: Uint8Array[] = [];
	const add = (value: string | Uint8Array) => {
		objects.push(typeof value === 'string' ? encoder.encode(value) : value);
		return objects.length;
	};
	const concat = (parts: Uint8Array[]) => {
		const out = new Uint8Array(
			parts.reduce((sum, part) => sum + part.length, 0)
		);
		let offset = 0;
		for (const part of parts) {
			out.set(part, offset);
			offset += part.length;
		}
		return out;
	};
	add('<< /Type /Catalog /Pages 2 0 R >>');
	add('');
	const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
	let content = 'BT /F1 18 Tf 40 750 Td (Sonora rendering benchmark) Tj ET\n';
	let imageId: number | undefined;
	if (kind === 'scan') {
		const canvas = document.createElement('canvas');
		canvas.width = 1800;
		canvas.height = 2400;
		const ctx = canvas.getContext('2d')!;
		ctx.fillStyle = '#faf9f5';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.fillStyle = '#111';
		ctx.strokeStyle = '#222';
		for (let staff = 0; staff < 18; staff++) {
			for (let line = 0; line < 5; line++) {
				const y = 100 + staff * 120 + line * 9;
				ctx.beginPath();
				ctx.moveTo(80, y);
				ctx.lineTo(1720, y);
				ctx.stroke();
			}
			for (let note = 0; note < 36; note++) {
				const x = 105 + note * 44,
					y = 113 + staff * 120 + ((note * 7 + staff) % 6) * 5;
				ctx.beginPath();
				ctx.ellipse(x, y, 8, 5, -0.3, 0, Math.PI * 2);
				ctx.fill();
				ctx.fillRect(x + 7, y - 35, 2, 35);
			}
		}
		const blob = await new Promise<Blob>((resolve) =>
			canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', 0.92)
		);
		const jpeg = new Uint8Array(await blob.arrayBuffer());
		imageId = add(
			concat([
				encoder.encode(
					`<< /Type /XObject /Subtype /Image /Width 1800 /Height 2400 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
				),
				jpeg,
				encoder.encode('\nendstream')
			])
		);
		content += 'q 552 0 0 700 30 30 cm /Im1 Do Q\n';
	} else {
		content += '0.4 w\n';
		for (let staff = 0; staff < 28; staff++) {
			for (let line = 0; line < 5; line++) {
				const y = 35 + staff * 24 + line * 2;
				content += `35 ${y} m 575 ${y} l S\n`;
			}
			for (let note = 0; note < 45; note++) {
				const x = 40 + note * 12,
					y = 37 + staff * 24 + ((note * 7 + staff) % 8);
				content += `${x} ${y} 3 2 re f ${x + 3} ${y} m ${x + 3} ${y + 12} l S\n`;
			}
		}
	}
	const stream = add(
		`<< /Length ${encoder.encode(content).length} >>\nstream\n${content}endstream`
	);
	const pages = Array.from({ length: pageCount }, () =>
		add(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> ${imageId ? `/XObject << /Im1 ${imageId} 0 R >>` : ''} >> /Contents ${stream} 0 R >>`
		)
	);
	objects[1] = encoder.encode(
		`<< /Type /Pages /Count ${pageCount} /Kids [${pages.map((page) => `${page} 0 R`).join(' ')}] >>`
	);
	const parts = [encoder.encode('%PDF-1.4\n')];
	const offsets = [0];
	let offset = parts[0].length;
	objects.forEach((object, index) => {
		offsets.push(offset);
		const part = concat([
			encoder.encode(`${index + 1} 0 obj\n`),
			object,
			encoder.encode('\nendobj\n')
		]);
		parts.push(part);
		offset += part.length;
	});
	parts.push(
		encoder.encode(
			`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
				.slice(1)
				.map((value) => `${String(value).padStart(10, '0')} 00000 n \n`)
				.join(
					''
				)}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`
		)
	);
	return concat(parts);
}
