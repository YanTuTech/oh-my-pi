/** Fixed external-library worlds for v2. Contains data, never task goals or grading rules. */
export const CHALLENGE_SEEDS: readonly number[] = [17, 29, 43];
export type ChallengeSide = "primary" | "secondary";

export interface LibraryRecord {
	id: string;
	revision: number;
	title: string;
	year: number;
	checksum: string;
}

export interface LibraryWorld {
	snapshot: string;
	topic: string;
	year: number;
	records: LibraryRecord[];
}

function token(value: string): string {
	return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 12);
}

/** No clock, network, process randomness or mutable shared state. A seed fixes both sources. */
export function createLibraryWorld(seed: number, side: ChallengeSide): LibraryWorld {
	if (!Number.isSafeInteger(seed) || seed < 1 || seed > 65535) throw new Error("Invalid library seed");
	const topics = ["lumen retrieval", "cedar transport", "quartz ranking"];
	const sampleIndex = CHALLENGE_SEEDS.indexOf(seed);
	const topic = topics[(sampleIndex < 0 ? seed : sampleIndex) % topics.length];
	const year = 2023 + (sampleIndex < 0 ? seed % 3 : sampleIndex);
	const id = `rec-${token(`record:${seed}`)}`;
	const revision = 2 + (seed % 3) + (side === "secondary" ? 1 : 0);
	const record = (recordId: string, rev: number, title: string, published: number): LibraryRecord => ({
		id: recordId,
		revision: rev,
		title,
		year: published,
		checksum: token(`${seed}:${side}:${recordId}:${rev}:${published}`),
	});
	return {
		snapshot: `snapshot-${token(`${seed}:${side}`)}`,
		topic,
		year,
		// Distractors precede the current record. First hit is deliberately not the answer.
		records: [
			record(id, 1, topic, year),
			record(`rec-${token(`older:${seed}`)}`, revision + 3, topic, year - 1),
			record(`rec-${token(`other:${seed}`)}`, revision + 4, "calibration notes", year),
			record(id, revision, topic, year),
		],
	};
}

export function searchLibrary(world: LibraryWorld, query: string, year?: number): LibraryRecord[] {
	const words = query.trim().toLowerCase().split(/\s+/);
	if (!query.trim()) return [];
	return world.records.filter(
		record =>
			(year === undefined || record.year === year) &&
			words.every(word => record.title.toLowerCase().includes(word) || record.id.toLowerCase().includes(word)),
	);
}
