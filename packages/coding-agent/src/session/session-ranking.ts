import { FuzzyText } from "../utils/fuzzy";
import type { SessionInfo } from "./session-listing";

function sessionSearchText(session: SessionInfo): string {
	return [
		session.id,
		session.title ?? "",
		session.cwd ?? "",
		session.firstMessage ?? "",
		session.allMessagesText,
		session.path,
	]
		.filter(Boolean)
		.join(" ");
}

const kSearchTextLower = Symbol("session.searchTextLower");

interface SearchableSessionInfo extends SessionInfo {
	[kSearchTextLower]?: string;
}

function sessionTextLower(session: SessionInfo): string {
	const tagged = session as SearchableSessionInfo;
	let textLower = tagged[kSearchTextLower];
	if (textLower === undefined) {
		textLower = sessionSearchText(session).toLowerCase();
		tagged[kSearchTextLower] = textLower;
	}
	return textLower;
}

function tokenizeSessionQuery(query: string): string[] {
	const trimmed = query.trim().toLowerCase();
	return trimmed ? trimmed.split(/\s+/) : [];
}

function compareSessionRecency(a: SessionInfo, b: SessionInfo): number {
	return b.modified.getTime() - a.modified.getTime();
}

const MIN_PURE_FUZZY_TOKEN_SCORE = -20;

interface RankedSessionMatch {
	session: SessionInfo;
	score: number;
	index: number;
}

function isLiteralMatch(textLower: string, tokens: string[]): boolean {
	for (const token of tokens) {
		if (!textLower.includes(token)) return false;
	}
	return true;
}

function scoreFuzzySession(
	session: SessionInfo,
	index: number,
	tokens: string[],
	fuzzy: FuzzyText,
): RankedSessionMatch | undefined {
	let score = 0;
	let worstTokenScore = Number.NEGATIVE_INFINITY;
	for (const token of tokens) {
		const match = fuzzy.match(token);
		if (!match.matches) return undefined;
		score += match.score;
		worstTokenScore = Math.max(worstTokenScore, match.score);
	}
	if (worstTokenScore >= MIN_PURE_FUZZY_TOKEN_SCORE) return undefined;
	return { session, score, index };
}

function compareLiteralRank(a: RankedSessionMatch, b: RankedSessionMatch): number {
	return compareSessionRecency(a.session, b.session) || a.index - b.index;
}

function compareFuzzyRank(a: RankedSessionMatch, b: RankedSessionMatch): number {
	return a.score - b.score || compareSessionRecency(a.session, b.session) || a.index - b.index;
}

/** Rank resumable sessions without depending on a selector or terminal renderer. */
export function rankSessionSearchMatches(allSessions: SessionInfo[], query: string): SessionInfo[] {
	const tokens = tokenizeSessionQuery(query);
	if (tokens.length === 0) return allSessions;

	const literal: RankedSessionMatch[] = [];
	const fuzzyMatches: RankedSessionMatch[] = [];
	for (let index = 0; index < allSessions.length; index++) {
		const session = allSessions[index]!;
		const textLower = sessionTextLower(session);
		if (isLiteralMatch(textLower, tokens)) {
			literal.push({ session, score: 0, index });
			continue;
		}
		const match = scoreFuzzySession(session, index, tokens, new FuzzyText(textLower));
		if (match) fuzzyMatches.push(match);
	}

	literal.sort(compareLiteralRank);
	fuzzyMatches.sort(compareFuzzyRank);
	return [...literal, ...fuzzyMatches].map(match => match.session);
}

/** Merge metadata ranking with prompt-history matches from the host database. */
export function mergeSessionRanking(
	allSessions: SessionInfo[],
	metadataMatches: SessionInfo[],
	historyIds: string[],
): SessionInfo[] {
	if (historyIds.length === 0) return metadataMatches;

	const sessionsById = new Map<string, SessionInfo>();
	for (const session of allSessions) {
		if (!sessionsById.has(session.id)) sessionsById.set(session.id, session);
	}

	const historyMatches: SessionInfo[] = [];
	const historyPaths = new Set<string>();
	for (const id of historyIds) {
		const session = sessionsById.get(id);
		if (!session || historyPaths.has(session.path)) continue;
		historyMatches.push(session);
		historyPaths.add(session.path);
	}
	if (historyMatches.length === 0) return metadataMatches;

	return [...historyMatches, ...metadataMatches.filter(session => !historyPaths.has(session.path))];
}
