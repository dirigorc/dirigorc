export interface Reporter {
	id: string;
	displayName: string;
	bot?: boolean;
}

export interface ReportInference {
	self_report: true;
	runner: string;
	runner_source: "reporter";
	reported_on?: string;
	date_source: "text" | "inferred";
	reporter_name: string;
	reporter_id: string;
	notes: string[];
}

export interface PreparedRecap {
	editorialMode: "verbatim" | "agentic" | "self-report";
	inference: ReportInference | null;
}

interface MemberName {
	pattern: RegExp;
	replacements: string[];
	kind: "given" | "family" | "abbrev";
}

const MEMBER_NAMES: MemberName[] = [
	{ pattern: /\bDave\s+O\b/i, replacements: ["Dave Ouellette"], kind: "abbrev" },
	{ pattern: /\bAshby\b/i, replacements: ["Robert Ashby", "Rob Ashby"], kind: "family" },
	{ pattern: /\bDenari\b/i, replacements: ["Nick Denari", "Nicholas Denari"], kind: "family" },
	{ pattern: /\bHarmon\b/i, replacements: ["Chris Harmon"], kind: "family" },
	{ pattern: /\bChad\b/i, replacements: ["Chad Boucher"], kind: "given" },
	{ pattern: /\bNate\b/i, replacements: ["Nate Priest", "Nate Madeira", "Nathan Madeira"], kind: "given" },
	{ pattern: /\bSeth\b/i, replacements: ["Seth Crockett"], kind: "given" },
	{ pattern: /\bCrow\b/i, replacements: ["Crow Norlander"], kind: "given" },
	{ pattern: /\bMarah\b/i, replacements: ["Marah Borgman"], kind: "given" },
	{ pattern: /\bKarley\b/i, replacements: ["Karley Piers"], kind: "given" },
	{ pattern: /\bAly\b/i, replacements: ["Aly Ursiny"], kind: "given" },
	{ pattern: /\bCliodhna\b/i, replacements: ["Cliodhna O'Malley", "Clíodhna O'Malley"], kind: "given" },
	{ pattern: /\bVeronica\b/i, replacements: ["Veronica Graziano"], kind: "given" },
	{ pattern: /\bHeather\b/i, replacements: ["Heather Gallant"], kind: "given" },
	{ pattern: /\bAdane\b/i, replacements: ["Adane Bewset"], kind: "given" },
	{ pattern: /\bDeven\b/i, replacements: ["Deven Abrams"], kind: "given" },
	{ pattern: /\bEric\b/i, replacements: ["Eric Sofen"], kind: "given" },
	{ pattern: /\bAlexis\b/i, replacements: ["Alexis Wilbert"], kind: "given" },
	{ pattern: /\bDan\b/i, replacements: ["Dan Bannon"], kind: "given" },
	{ pattern: /\bNick\b/i, replacements: ["Nick Denari", "Nicholas Denari"], kind: "given" },
	{ pattern: /\bJorma\b/i, replacements: ["Jorma Kurry"], kind: "given" },
	{ pattern: /\bLaurel\b/i, replacements: ["Laurel Manville", "Laurel Driscoll"], kind: "given" },
	{ pattern: /\bJustin\b/i, replacements: ["Justin Freeman", "Justin Tomison"], kind: "given" },
];

const GIVEN_NAMES = givenNames(MEMBER_NAMES);

const KNOWN_DISCORD_RUNNERS: Record<string, string> = {
	"1227055686295359519": "Seth Crockett",
	"459385898992140288": "Crow Norlander",
};

const NON_PERSON_WORDS = new Set([
	"age", "april", "august", "back", "bay", "beach", "beacon", "bean", "boston", "breakaway",
	"bridge", "brunswick", "cape", "championship", "championships", "chase", "chicago", "christmas",
	"classic", "club", "community", "country", "course", "cove", "cross", "cup", "dash", "day",
	"december", "dirigo", "east", "elizabeth", "england", "falmouth", "fall", "february", "festival",
	"field", "four", "fourth", "freeport", "friday", "full", "great", "group", "half", "high",
	"independence", "invitational", "island", "january", "july", "june", "kids", "labor", "lake",
	"little", "long", "maine", "marathon", "march", "market", "masters", "may", "mayor", "mayors",
	"memorial", "men", "mile", "miles", "monday", "mount", "mountain", "new", "north", "november",
	"october", "old", "overall", "park", "port", "portland", "race", "record", "relay", "river",
	"road", "running", "saturday", "school", "september", "series", "short", "south", "spring",
	"square", "state", "states", "summer", "sunday", "team", "thanksgiving", "thursday", "track",
	"trail", "tuesday", "twilight", "ultra", "united", "valor", "wednesday", "weekly", "west",
	"winter", "women", "yarmouth", "york", "youth",
]);

export const DATEISH_PATTERN = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|today|tomorrow|tonight|next\s+week|this\s+weekend|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{4}-\d{2}-\d{2})\b/i;
const RESULTISH_PATTERN = /\b(?:\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?|\d+(?:\.\d+)?\s?(?:k|mile|miler|marathon|half|meters?|m|place|overall|oa|win|winner|won|pr|pb|course record|age group|ag)|results?)\b/i;
const PERSON_PAIR_PATTERN = /\b[A-Z][a-z'’-]+(?:\s+[A-Z][a-z'’-]+){1,2}\b/g;
const PERSON_ACTION_PATTERN = /\b([A-Z][a-z'’-]+)\s+(?:ran|finished|won|placed|clocked|took|posted|raced)\b/g;
const SELF_REPORT_WORD_LIMIT = 120;
const SELF_REPORT_CHAR_LIMIT = 1000;

export function reporterFromUser(user: { id?: string; username?: string; global_name?: string | null; bot?: boolean }): Reporter {
	const displayName = (user.global_name || user.username || "Unknown Discord user").trim() || "Unknown Discord user";
	return {
		id: user.id || "",
		displayName,
		bot: user.bot === true,
	};
}

export function formatReporter(reporter: Reporter): string {
	return reporter.id ? `${reporter.displayName} (${reporter.id})` : reporter.displayName;
}

export function easternDate(epochMs: number): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "America/New_York",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(epochMs));
}

export function recapEmojiName(configured: string | undefined): string {
	const name = configured?.trim();
	return name || "🏁";
}

export function emojiMatches(name: string, configured: string | undefined): boolean {
	const expected = recapEmojiName(configured);
	return name === expected || name.toLowerCase() === expected.toLowerCase();
}

export function recapStartedMessage(editorialMode: string): string {
	if (editorialMode === "self-report") {
		return "Got it. I started a website update from that result. Where the note left out a name, I used the reporting runner, and where it left out a date, I used the reporting day.";
	}
	if (editorialMode === "agentic") return "Got it. I started an AI-edited website update PR for review.";
	return "Got it. I started a verbatim-copy website update PR for review.";
}

// Shorthand is "Nate", "Ashby", or "Dave O". "Nate Madeira" is already complete,
// including when that last name is not one of the suggested replacements.
export function incompleteMemberNameReason(body: string): string {
	const matches: string[] = [];
	for (const item of MEMBER_NAMES) {
		if (occurrences(body, item.pattern).length === 0) continue;
		if (listedNameIsComplete(body, item)) continue;
		matches.push(item.replacements.join(" or "));
	}
	const unique = [...new Set(matches)];
	if (unique.length === 0) return "";
	const examples = unique.slice(0, 5).join(", ");
	const suffix = unique.length > 5 ? ", etc." : "";
	return `Please use full member names before I create a PR. Possible fixes: ${examples}${suffix}.`;
}

export function isSelfReport(body: string, reporter: Reporter): boolean {
	const trimmed = body.trim();
	if (!trimmed || reporter.bot) return false;
	if (trimmed.length > SELF_REPORT_CHAR_LIMIT || wordCount(trimmed) > SELF_REPORT_WORD_LIMIT) return false;
	if (isTeamNote(trimmed)) return false;
	if (!RESULTISH_PATTERN.test(trimmed)) return false;
	return otherPeople(trimmed, runnerName(reporter).name).length === 0;
}

export function prepareRecap(
	body: string,
	reporter: Reporter,
	reportedAtMs: number,
	requestedMode: "verbatim" | "agentic",
): PreparedRecap {
	if (!isSelfReport(body, reporter)) {
		return { editorialMode: requestedMode, inference: null };
	}
	const resolved = runnerName(reporter);
	const hasDate = DATEISH_PATTERN.test(body);
	const reportedOn = easternDate(reportedAtMs);
	const notes = [`${resolved.name} is the runner because the note does not name someone else.`];
	if (resolved.expanded) notes.push(`Discord name "${reporter.displayName}" is ${resolved.name}.`);
	if (resolved.ambiguous) notes.push(`"${reporter.displayName}" matches more than one member, so the full name still needs review.`);
	if (!hasDate) notes.push(`${reportedOn} is the reporting day in Eastern Time because the note did not include a date.`);
	return {
		editorialMode: "self-report",
		inference: {
			self_report: true,
			runner: resolved.name,
			runner_source: "reporter",
			...(hasDate ? {} : { reported_on: reportedOn }),
			date_source: hasDate ? "text" : "inferred",
			reporter_name: reporter.displayName,
			reporter_id: reporter.id,
			notes,
		},
	};
}

export function noteHasResultOrUrl(text: string): boolean {
	const trimmed = text.trim();
	return RESULTISH_PATTERN.test(trimmed) || /https?:\/\//i.test(trimmed);
}

export function recapClarificationReason(
	body: string,
	reporter: Reporter | null,
	requestedAttachments: number,
	nearbyEvidence?: { readonly text: string; readonly images: number },
): string {
	const trimmed = body.trim();
	const words = wordCount(trimmed);
	if (!trimmed) return "Please add the race recap or club note.";
	if (reporter && isSelfReport(trimmed, reporter)) return "";
	const incompleteNameReason = incompleteMemberNameReason(trimmed);
	if (incompleteNameReason) return incompleteNameReason;
	if (requestedAttachments > 0) return "";
	if (nearbyEvidenceClears(nearbyEvidence)) return "";
	if (words < 6) return "Please add a few more details before I create an update PR.";
	if (words < 16 && !noteHasResultOrUrl(trimmed)) return "Please add a result, race name, date, or source link so the update has enough context.";
	return "";
}

function nearbyEvidenceClears(evidence: { readonly text: string; readonly images: number } | undefined): boolean {
	if (!evidence) return false;
	if (evidence.images > 0) return true;
	return noteHasResultOrUrl(evidence.text) || wordCount(evidence.text) >= 6;
}

function wordCount(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

function includesFullName(text: string, names: string[]): boolean {
	const normalized = text.toLowerCase();
	return names.some((name) => normalized.includes(name.toLowerCase()));
}

const NAME_TOKEN = /^[A-ZÀ-Ý][A-Za-zÀ-ÿ'’-]+$/;
const FUNCTION_WORDS = new Set([
	"a", "an", "and", "or", "the", "with", "for", "to", "of", "in", "on", "at", "by", "from",
	"his", "her", "their", "who", "but", "nor", "via", "through", "into", "over", "after",
	"before", "then", "than", "that", "this", "these", "those", "our", "your", "its",
	"was", "were", "had", "has", "have", "also", "again", "just", "still", "very", "too",
	"ran", "running", "raced", "finished", "won", "placed", "clocked", "took", "posted",
	"pacing", "paced", "led", "did", "does",
]);

function givenNames(items: readonly MemberName[]): Set<string> {
	const names = new Set<string>();
	for (const item of items) {
		if (item.kind === "given") {
			const word = patternWord(item.pattern);
			if (word) names.add(word.toLowerCase());
		}
		for (const replacement of item.replacements) {
			const first = replacement.split(/\s+/)[0];
			if (first) names.add(first.toLowerCase());
		}
	}
	return names;
}

function patternWord(pattern: RegExp): string {
	return pattern.source.match(/[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’-]+/)?.[0] ?? "";
}

function occurrences(body: string, pattern: RegExp): RegExpMatchArray[] {
	const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
	return [...body.matchAll(new RegExp(pattern.source, flags))];
}

function cleanToken(raw: string): string {
	return raw.replace(/^[^A-Za-zÀ-ÿ]+|[^A-Za-zÀ-ÿ'’-]+$/g, "");
}

function tokenAfter(body: string, index: number): string {
	const match = /\s*(\S+)/.exec(body.slice(index));
	return cleanToken(match?.[1] ?? "");
}

function tokenBefore(body: string, index: number): string {
	const match = /(\S+)\s*$/.exec(body.slice(0, index));
	return cleanToken(match?.[1] ?? "");
}

function isNameToken(token: string): boolean {
	if (!NAME_TOKEN.test(token)) return false;
	const folded = token.toLowerCase();
	return !NON_PERSON_WORDS.has(folded) && !FUNCTION_WORDS.has(folded);
}

function isSurnameToken(token: string): boolean {
	return isNameToken(token) && !GIVEN_NAMES.has(token.toLowerCase());
}

function givenNameIsPaired(body: string, item: MemberName): boolean {
	return occurrences(body, item.pattern).some((match) => {
		const start = match.index ?? 0;
		return isSurnameToken(tokenAfter(body, start + match[0].length));
	});
}

function familyNameIsPaired(body: string, item: MemberName): boolean {
	return occurrences(body, item.pattern).some((match) => {
		const start = match.index ?? 0;
		return isNameToken(tokenBefore(body, start));
	});
}

function listedNameIsComplete(body: string, item: MemberName): boolean {
	if (includesFullName(body, item.replacements)) return true;
	switch (item.kind) {
		case "abbrev":
			return false;
		case "given":
			return givenNameIsPaired(body, item);
		case "family":
			return familyNameIsPaired(body, item);
		default: {
			const unexpected: never = item.kind;
			throw new Error(`Unexpected member name kind: ${String(unexpected)}`);
		}
	}
}

function isTeamNote(text: string): boolean {
	const plural = /\b(?:we|our|ours|us)\b/i.test(text);
	const singular = /\b(?:i|i'm|im|i've|ive|my|me|myself)\b/i.test(text);
	return plural && !singular;
}

export function memberName(reporter: Reporter): string {
	return runnerName(reporter).name;
}

function runnerName(reporter: Reporter): { name: string; expanded: boolean; ambiguous: boolean } {
	const known = KNOWN_DISCORD_RUNNERS[reporter.id];
	if (known) {
		return {
			name: known,
			expanded: known.toLowerCase() !== reporter.displayName.toLowerCase(),
			ambiguous: false,
		};
	}
	for (const item of MEMBER_NAMES) {
		if (!item.pattern.test(reporter.displayName)) continue;
		const exact = item.replacements.find((name) => name.toLowerCase() === reporter.displayName.toLowerCase());
		if (exact) return { name: exact, expanded: false, ambiguous: false };
		if (includesFullName(reporter.displayName, item.replacements)) {
			return { name: reporter.displayName, expanded: false, ambiguous: false };
		}
		if (item.replacements.length === 1) {
			return { name: item.replacements[0], expanded: true, ambiguous: false };
		}
		return { name: reporter.displayName, expanded: false, ambiguous: true };
	}
	return { name: reporter.displayName, expanded: false, ambiguous: false };
}

function nameIsReporter(candidate: string, reporterName: string): boolean {
	const candidateNorm = candidate.toLowerCase();
	const reporterNorm = reporterName.toLowerCase();
	if (candidateNorm === reporterNorm) return true;
	if (reporterNorm.startsWith(`${candidateNorm} `)) return true;
	if (reporterNorm.endsWith(` ${candidateNorm}`)) return true;
	return false;
}

function patternIsReporter(item: MemberName, reporterName: string): boolean {
	if (item.replacements.some((name) => name.toLowerCase() === reporterName.toLowerCase())) return true;
	return item.pattern.test(reporterName);
}

function otherPeople(text: string, reporterName: string): string[] {
	const found = new Set<string>();
	for (const item of MEMBER_NAMES) {
		if (!item.pattern.test(text)) continue;
		const fullInText = item.replacements.filter((name) => text.toLowerCase().includes(name.toLowerCase()));
		if (fullInText.length > 0) {
			for (const name of fullInText) {
				if (!nameIsReporter(name, reporterName)) found.add(name);
			}
			continue;
		}
		if (patternIsReporter(item, reporterName)) continue;
		found.add(item.replacements[0]);
	}
	PERSON_PAIR_PATTERN.lastIndex = 0;
	for (const match of text.match(PERSON_PAIR_PATTERN) || []) {
		const parts = match.split(/\s+/);
		if (parts.some((part) => NON_PERSON_WORDS.has(part.toLowerCase().replace(/[^a-z]/g, "")))) continue;
		if (nameIsReporter(match, reporterName)) continue;
		found.add(match);
	}
	PERSON_ACTION_PATTERN.lastIndex = 0;
	for (const match of text.matchAll(PERSON_ACTION_PATTERN)) {
		const name = match[1];
		if (!name || NON_PERSON_WORDS.has(name.toLowerCase())) continue;
		if (nameIsReporter(name, reporterName)) continue;
		found.add(name);
	}
	return [...found];
}
