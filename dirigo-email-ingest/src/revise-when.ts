// Turns a revision instruction into a calendar day and the words that can
// pick one event or post. The day is a civil date in America/New_York.

export interface RevisionWhen {
	readonly date: string | null;
	readonly words: readonly string[];
}

export interface RevisionCandidate {
	readonly kind: "post" | "event";
	readonly path: string;
	readonly title: string;
}

export const REVISION_HINT = "Say which page to correct, or name a day like Saturday or Oct 31.";

const WEEKDAY_INDEX: Record<string, number> = {
	sunday: 0,
	sun: 0,
	monday: 1,
	mon: 1,
	tuesday: 2,
	tue: 2,
	tues: 2,
	wednesday: 3,
	wed: 3,
	thursday: 4,
	thu: 4,
	thur: 4,
	thurs: 4,
	friday: 5,
	fri: 5,
	saturday: 6,
	sat: 6,
};

const MONTHS: Record<string, number> = {
	january: 1,
	jan: 1,
	february: 2,
	feb: 2,
	march: 3,
	mar: 3,
	april: 4,
	apr: 4,
	may: 5,
	june: 6,
	jun: 6,
	july: 7,
	jul: 7,
	august: 8,
	aug: 8,
	september: 9,
	sept: 9,
	sep: 9,
	october: 10,
	oct: 10,
	november: 11,
	nov: 11,
	december: 12,
	dec: 12,
};

const DROP = new Set<string>([
	...Object.keys(WEEKDAY_INDEX),
	...Object.keys(MONTHS),
	"weekend",
	"today",
	"tomorrow",
	"tonight",
	"yesterday",
	"week",
	"weeks",
	"next",
	"last",
	"this",
	"that",
	"the",
	"and",
	"for",
	"our",
	"are",
	"was",
	"were",
	"not",
	"but",
	"one",
	"off",
	"out",
	"too",
	"can",
	"its",
	"meet",
	"meets",
	"meeting",
	"from",
	"with",
	"will",
	"have",
	"been",
	"they",
	"them",
	"your",
	"just",
	"only",
	"also",
	"into",
	"onto",
	"over",
	"under",
	"about",
	"there",
	"here",
	"please",
	"change",
	"changed",
	"update",
	"updated",
	"instead",
	"should",
	"would",
	"could",
	"running",
	"usual",
	"usually",
	"spot",
	"than",
	"then",
	"when",
	"what",
	"where",
	"which",
	"while",
	"after",
	"before",
	"during",
	"every",
	"each",
	"some",
	"more",
	"most",
	"other",
	"another",
	"same",
	"make",
	"move",
	"moved",
	"keep",
	"leave",
	"left",
	"both",
	"all",
	"very",
	"dont",
	"does",
	"note",
	"notes",
	"time",
	"date",
	"dates",
	"start",
	"starts",
	"location",
	"place",
	"event",
	"events",
	"series",
	"weekly",
	"group",
	"long",
	"run",
	"runs",
	"park",
	"race",
	"morning",
	"afternoon",
	"evening",
	"earlier",
	"later",
	"club",
	"dirigo",
	"team",
	"home",
]);

const WEEKDAY_PATTERN = "sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tues|tue|wed|thurs|thur|thu|fri|sat";
const MONTH_PATTERN = "january|february|march|april|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec";

export function describeRevision(text: string, nowMs: number): RevisionWhen {
	const today = easternIso(nowMs);
	return {
		date: explicitDate(text, today) || relativeDate(text, today, weekdayOf(today)),
		words: revisionWords(text),
	};
}

export function revisionScore(title: string, words: readonly string[]): number {
	if (words.length === 0) return 0;
	const tokens = new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3));
	let score = 0;
	for (const word of words) {
		if (tokens.has(word)) score += 1;
	}
	return score;
}

export function chooseRevision(
	candidates: readonly RevisionCandidate[],
	words: readonly string[],
	date: string | null,
): RevisionCandidate | { reason: string } {
	if (candidates.length === 0) {
		return { reason: date ? `Nothing on the site matches ${date}.` : REVISION_HINT };
	}
	if (date && candidates.length === 1) return candidates[0];
	const scored = candidates.map((candidate) => ({ candidate, score: revisionScore(candidate.title, words) }));
	const max = Math.max(0, ...scored.map((item) => item.score));
	const top = scored.filter((item) => item.score === max && item.score > 0);
	if (top.length === 1) return top[0].candidate;
	if (!date && top.length === 0) return { reason: REVISION_HINT };
	const shown = top.length > 1 ? top.map((item) => item.candidate) : candidates;
	return { reason: `More than one page matches. Name one of: ${nameList(shown)}.` };
}

function revisionWords(text: string): string[] {
	const words: string[] = [];
	const seen = new Set<string>();
	for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
		if (token.length < 3 || /^\d+$/.test(token) || DROP.has(token) || seen.has(token)) continue;
		seen.add(token);
		words.push(token);
	}
	return words;
}

function explicitDate(text: string, today: string): string | null {
	const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
	if (iso) {
		const parsed = isoOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));
		if (parsed) return parsed;
	}
	const month = new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i").exec(text);
	if (month) {
		const year = month[3] ? Number(month[3]) : null;
		const parsed = withYear(MONTHS[month[1].toLowerCase()] || 0, Number(month[2]), year, today);
		if (parsed) return parsed;
	}
	const numeric = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(text);
	if (numeric) {
		const year = numeric[3] ? expandYear(Number(numeric[3])) : null;
		const parsed = withYear(Number(numeric[1]), Number(numeric[2]), year, today);
		if (parsed) return parsed;
	}
	return null;
}

function relativeDate(text: string, today: string, todayWeekday: number): string | null {
	const weekend = /\b(this|last)\s+weekend\b/i.exec(text);
	if (weekend) {
		const saturday = thisWeekendSaturday(today, todayWeekday);
		return weekend[1].toLowerCase() === "last" ? addDays(saturday, -7) : saturday;
	}
	const weekday = new RegExp(`\\b(?:(this|next|last)\\s+)?(${WEEKDAY_PATTERN})\\b`, "i").exec(text);
	if (weekday) {
		const target = WEEKDAY_INDEX[weekday[2].toLowerCase()];
		if (typeof target !== "number") return null;
		const qualifier = weekday[1]?.toLowerCase() || "";
		if (qualifier === "last") return lastWeekday(today, todayWeekday, target);
		if (qualifier === "next" || /\bnext\s+week\b/i.test(text)) return nextWeekday(today, todayWeekday, target);
		return onOrAfterWeekday(today, todayWeekday, target);
	}
	const named = /\b(today|tonight|tomorrow|yesterday)\b/i.exec(text);
	if (named) {
		const word = named[1].toLowerCase();
		if (word === "today" || word === "tonight") return today;
		if (word === "tomorrow") return addDays(today, 1);
		return addDays(today, -1);
	}
	if (/\bnext\s+week\b/i.test(text)) return addDays(today, 7);
	return null;
}

function withYear(month: number, day: number, year: number | null, today: string): string | null {
	if (year) return isoOf(year, month, day);
	const thisYear = Number(today.slice(0, 4));
	const candidate = isoOf(thisYear, month, day);
	if (!candidate) return null;
	return candidate >= today ? candidate : isoOf(thisYear + 1, month, day);
}

function expandYear(year: number): number {
	if (year >= 100) return year;
	return year >= 70 ? 1900 + year : 2000 + year;
}

function thisWeekendSaturday(today: string, todayWeekday: number): string {
	if (todayWeekday === 0) return addDays(today, -1);
	return onOrAfterWeekday(today, todayWeekday, 6);
}

function onOrAfterWeekday(today: string, todayWeekday: number, target: number): string {
	return addDays(today, (target - todayWeekday + 7) % 7);
}

function nextWeekday(today: string, todayWeekday: number, target: number): string {
	return addDays(onOrAfterWeekday(today, todayWeekday, target), 7);
}

function lastWeekday(today: string, todayWeekday: number, target: number): string {
	const delta = (todayWeekday - target + 7) % 7;
	return addDays(today, delta === 0 ? -7 : -delta);
}

function addDays(iso: string, days: number): string {
	const [year, month, day] = iso.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function weekdayOf(iso: string): number {
	const [year, month, day] = iso.split("-").map(Number);
	return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function isoOf(year: number, month: number, day: number): string | null {
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	return date.toISOString().slice(0, 10);
}

function easternIso(epochMs: number): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "America/New_York",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(epochMs));
}

function nameList(candidates: readonly RevisionCandidate[]): string {
	const titles = candidates.slice(0, 6).map((candidate) => candidate.title.trim() || candidate.path);
	return candidates.length > 6 ? `${titles.join("; ")}; …` : titles.join("; ");
}
