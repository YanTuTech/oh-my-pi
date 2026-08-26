const hashBuffer = new ArrayBuffer(8);
const hashView = new DataView(hashBuffer);
const hashBytes1 = new Uint8Array(hashBuffer, 0, 1);
const hashBytes4 = new Uint8Array(hashBuffer, 0, 4);
const hashBytes8 = new Uint8Array(hashBuffer, 0, 8);

/** Incremental xxHash64 key builder for strings and scalar values. */
export class Hasher {
	#hash = 0n;

	str(value: string): this {
		hashView.setUint32(0, value.length);
		this.#hash = Bun.hash.xxHash64(hashBytes4, this.#hash);
		this.#hash = Bun.hash.xxHash64(value, this.#hash);
		return this;
	}

	u32(value: number): this {
		hashView.setUint32(0, value);
		this.#hash = Bun.hash.xxHash64(hashBytes4, this.#hash);
		return this;
	}

	u64(value: bigint): this {
		hashView.setBigUint64(0, value);
		this.#hash = Bun.hash.xxHash64(hashBytes8, this.#hash);
		return this;
	}

	bool(value: boolean): this {
		hashView.setUint8(0, value ? 1 : 0);
		this.#hash = Bun.hash.xxHash64(hashBytes1, this.#hash);
		return this;
	}

	optional(value: string | undefined | null): this {
		if (value == null) {
			hashView.setUint8(0, 0xff);
			this.#hash = Bun.hash.xxHash64(hashBytes1, this.#hash);
		} else {
			this.#hash = Bun.hash.xxHash64(value, this.#hash);
		}
		return this;
	}

	digest(): bigint {
		return this.#hash;
	}
}
