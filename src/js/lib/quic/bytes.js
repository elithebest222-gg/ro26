// Byte helpers for QUIC and TLS: a growable writer, a bounds-checked reader, and QUIC's
// variable-length integers (RFC 9000 section 16).

export class Writer {
	constructor(size = 256) {
		this.buf = new Uint8Array(size);
		this.len = 0;
	}

	ensure(n) {
		if (this.len + n <= this.buf.length) return;
		let size = this.buf.length * 2;
		while (size < this.len + n) size *= 2;
		const next = new Uint8Array(size);
		next.set(this.buf.subarray(0, this.len));
		this.buf = next;
	}

	u8(v) {
		this.ensure(1);
		this.buf[this.len++] = v & 0xff;
		return this;
	}

	u16(v) {
		this.ensure(2);
		this.buf[this.len++] = (v >>> 8) & 0xff;
		this.buf[this.len++] = v & 0xff;
		return this;
	}

	u24(v) {
		this.ensure(3);
		this.buf[this.len++] = (v >>> 16) & 0xff;
		this.buf[this.len++] = (v >>> 8) & 0xff;
		this.buf[this.len++] = v & 0xff;
		return this;
	}

	u32(v) {
		this.ensure(4);
		this.buf[this.len++] = (v >>> 24) & 0xff;
		this.buf[this.len++] = (v >>> 16) & 0xff;
		this.buf[this.len++] = (v >>> 8) & 0xff;
		this.buf[this.len++] = v & 0xff;
		return this;
	}

	bytes(b) {
		this.ensure(b.length);
		this.buf.set(b, this.len);
		this.len += b.length;
		return this;
	}

	varint(v) {
		this.ensure(8);
		writeVarint(this.buf, this.len, v);
		this.len += varintLength(v);
		return this;
	}

	// TLS-style length-prefixed vector; `fn` writes the contents.
	vec(prefixBytes, fn) {
		const at = this.len;
		this.ensure(prefixBytes);
		this.len += prefixBytes;
		fn(this);
		const n = this.len - at - prefixBytes;
		for (let i = 0; i < prefixBytes; i++) this.buf[at + i] = (n >>> (8 * (prefixBytes - 1 - i))) & 0xff;
		return this;
	}

	done() {
		return this.buf.slice(0, this.len);
	}
}

export class Reader {
	constructor(buf, pos = 0, end = buf.length) {
		this.buf = buf;
		this.pos = pos;
		this.end = end;
	}

	get left() {
		return this.end - this.pos;
	}

	need(n) {
		if (this.pos + n > this.end) throw new Error("truncated");
	}

	u8() {
		this.need(1);
		return this.buf[this.pos++];
	}

	u16() {
		this.need(2);
		const v = (this.buf[this.pos] << 8) | this.buf[this.pos + 1];
		this.pos += 2;
		return v;
	}

	u24() {
		this.need(3);
		const v = (this.buf[this.pos] << 16) | (this.buf[this.pos + 1] << 8) | this.buf[this.pos + 2];
		this.pos += 3;
		return v;
	}

	u32() {
		this.need(4);
		const v = ((this.buf[this.pos] << 24) | (this.buf[this.pos + 1] << 16) | (this.buf[this.pos + 2] << 8) | this.buf[this.pos + 3]) >>> 0;
		this.pos += 4;
		return v;
	}

	bytes(n) {
		this.need(n);
		const b = this.buf.subarray(this.pos, this.pos + n);
		this.pos += n;
		return b;
	}

	varint() {
		this.need(1);
		const len = 1 << (this.buf[this.pos] >> 6);
		this.need(len);
		const v = readVarint(this.buf, this.pos);
		this.pos += len;
		return v;
	}

	vec(prefixBytes) {
		let n = 0;
		for (let i = 0; i < prefixBytes; i++) n = n * 256 + this.u8();
		return this.bytes(n);
	}
}

export function varintLength(v) {
	if (v < 0x40) return 1;
	if (v < 0x4000) return 2;
	if (v < 0x40000000) return 4;
	return 8;
}

export function writeVarint(buf, at, v) {
	const len = varintLength(v);
	if (len === 1) buf[at] = v;
	else if (len === 2) {
		buf[at] = 0x40 | (v >>> 8);
		buf[at + 1] = v & 0xff;
	} else if (len === 4) {
		buf[at] = 0x80 | ((v >>> 24) & 0x3f);
		buf[at + 1] = (v >>> 16) & 0xff;
		buf[at + 2] = (v >>> 8) & 0xff;
		buf[at + 3] = v & 0xff;
	} else {
		const hi = Math.floor(v / 2 ** 32);
		const lo = v >>> 0;
		buf[at] = 0xc0 | ((hi >>> 24) & 0x3f);
		buf[at + 1] = (hi >>> 16) & 0xff;
		buf[at + 2] = (hi >>> 8) & 0xff;
		buf[at + 3] = hi & 0xff;
		buf[at + 4] = (lo >>> 24) & 0xff;
		buf[at + 5] = (lo >>> 16) & 0xff;
		buf[at + 6] = (lo >>> 8) & 0xff;
		buf[at + 7] = lo & 0xff;
	}
	return len;
}

// Values above 2^53 lose precision; QUIC only uses those as "unlimited", which is fine.
export function readVarint(buf, at) {
	const first = buf[at];
	const len = 1 << (first >> 6);
	let v = first & 0x3f;
	for (let i = 1; i < len; i++) v = v * 256 + buf[at + i];
	return v;
}

export function concat(...parts) {
	let n = 0;
	for (const p of parts) n += p.length;
	const out = new Uint8Array(n);
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

export const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
export const fromHex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
export const utf8 = (s) => new TextEncoder().encode(s);

export function equalBytes(a, b) {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}
