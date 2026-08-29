function canonicalizeJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalizeJson);
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	const canonical: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort(compareCanonicalJsonStrings)) {
		const item = record[key];
		if (item !== undefined) canonical[key] = canonicalizeJson(item);
	}
	return canonical;
}

/** Locale-independent UTF-16 code-unit order used by the cross-process wire digest. */
export function compareCanonicalJsonStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

export interface CanonicalJsonLimits {
	maxDepth: number;
	maxNodes: number;
	maxObjectKeys: number;
	maxArrayLength: number;
	maxStringBytes: number;
	maxSerializedBytes: number;
}

/** Reject values whose ECMAScript object representation is not an exact JSON wire value. */
export function assertJsonWireValue(value: unknown, requireObject = false): void {
	if (requireObject && (!value || typeof value !== "object" || Array.isArray(value))) {
		throw new TypeError("Canonical JSON wire value must be an object");
	}
	const active = new WeakSet<object>();
	const visit = (item: unknown): void => {
		if (item === null || typeof item === "string" || typeof item === "boolean") return;
		if (typeof item === "number") {
			if (!Number.isFinite(item)) throw new TypeError("Canonical JSON number must be finite");
			return;
		}
		if (typeof item !== "object") throw new TypeError("Value is not representable on the JSON wire");
		if (active.has(item)) throw new TypeError("Canonical JSON value must not contain cycles");
		active.add(item);
		try {
			if (Array.isArray(item)) {
				const values: unknown[] = [];
				for (let index = 0; index < item.length; index++) {
					const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
					if (!descriptor) throw new TypeError("Canonical JSON arrays must not be sparse");
					if (!descriptor.enumerable || !("value" in descriptor)) {
						throw new TypeError("Canonical JSON arrays require enumerable data indices");
					}
					values.push(descriptor.value);
				}
				const ownKeys = Reflect.ownKeys(item);
				if (ownKeys.length !== item.length + 1 || !ownKeys.includes("length")) {
					throw new TypeError("Canonical JSON arrays must not contain extra properties");
				}
				for (const value of values) visit(value);
				return;
			}
			const prototype = Object.getPrototypeOf(item);
			if (prototype !== Object.prototype && prototype !== null) {
				throw new TypeError("Canonical JSON objects must be plain records");
			}
			const keys = Object.keys(item);
			if (Reflect.ownKeys(item).length !== keys.length) {
				throw new TypeError("Canonical JSON objects must contain only enumerable string keys");
			}
			const descriptors = Object.getOwnPropertyDescriptors(item);
			for (const key of keys) {
				const descriptor = descriptors[key];
				if (!descriptor || !("value" in descriptor)) {
					throw new TypeError("Canonical JSON objects must not contain accessors");
				}
				visit(descriptor.value);
			}
		} finally {
			active.delete(item);
		}
	};
	visit(value);
}

function assertCanonicalJsonLimits(value: unknown, limits: CanonicalJsonLimits): void {
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
	let nodes = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) break;
		nodes++;
		if (nodes > limits.maxNodes) throw new RangeError("Canonical JSON node limit exceeded");
		if (current.depth > limits.maxDepth) throw new RangeError("Canonical JSON depth limit exceeded");
		if (typeof current.value === "string") {
			if (Buffer.byteLength(current.value, "utf8") > limits.maxStringBytes) {
				throw new RangeError("Canonical JSON string limit exceeded");
			}
			continue;
		}
		if (!current.value || typeof current.value !== "object") continue;
		if (Array.isArray(current.value)) {
			if (current.value.length > limits.maxArrayLength) throw new RangeError("Canonical JSON array limit exceeded");
			for (const item of current.value) stack.push({ value: item, depth: current.depth + 1 });
			continue;
		}
		const entries = Object.entries(current.value);
		if (entries.length > limits.maxObjectKeys) throw new RangeError("Canonical JSON object-key limit exceeded");
		for (const [key, item] of entries) {
			if (Buffer.byteLength(key, "utf8") > limits.maxStringBytes) {
				throw new RangeError("Canonical JSON key limit exceeded");
			}
			stack.push({ value: item, depth: current.depth + 1 });
		}
	}
}

/** Serialize JSON with recursively sorted object keys for cross-process digests. */
export function canonicalJson(value: unknown, limits?: CanonicalJsonLimits): string {
	if (limits) assertCanonicalJsonLimits(value, limits);
	const serialized = JSON.stringify(canonicalizeJson(value));
	if (serialized === undefined) throw new TypeError("Value has no canonical JSON representation");
	if (limits && Buffer.byteLength(serialized, "utf8") > limits.maxSerializedBytes) {
		throw new RangeError("Canonical JSON serialized byte limit exceeded");
	}
	return serialized;
}
