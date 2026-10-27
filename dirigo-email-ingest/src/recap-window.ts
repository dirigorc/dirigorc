import {
	formatReporter,
	memberName,
	noteHasResultOrUrl,
	prepareRecap,
	recapClarificationReason,
	reporterFromUser,
	type ReportInference,
	type Reporter,
} from "./self-report";

export const NEARBY_LIMIT = 15;
export const MAX_IMAGES = 5;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_CONTENT_TYPES: ReadonlySet<string> = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
]);

const NEARBY_GAP_MS = 60 * 60 * 1000;
const CONTRIBUTING_WORDS = 6;

export interface RecapFlag {
	readonly channelId: string;
	readonly messageId: string;
	readonly guildId: string;
	readonly reactor: Reporter;
	readonly nowMs: number;
}

export interface ImageRef {
	readonly filename: string;
	readonly content_type: string;
	readonly size: number;
	readonly url: string;
}

export interface RecapEmailFields {
	readonly editorialMode: "verbatim" | "self-report" | "agentic";
	readonly inference: ReportInference | null;
	readonly text: string;
	readonly links: readonly string[];
	readonly images: readonly ImageRef[];
	readonly authoredBy: string;
	readonly submittedBy: string;
}

export type RecapDraft =
	| { readonly status: "skipped"; readonly reply: string }
	| { readonly status: "needs-detail"; readonly reply: string }
	| { readonly status: "ready"; readonly fields: RecapEmailFields };

interface MemberPost {
	readonly messageId: string;
	readonly atMs: number;
	readonly author: Reporter;
	readonly text: string;
	readonly links: readonly string[];
	readonly images: readonly ImageRef[];
}

interface ChannelWindow {
	readonly anchor: MemberPost;
	readonly nearby: readonly MemberPost[];
}

export function draftRecapFromMessages(anchorPayload: unknown, nearbyPayload: unknown, flag: RecapFlag): RecapDraft {
	const anchor = anchorPost(anchorPayload, flag);
	if (!anchor) {
		return {
			status: "needs-detail",
			reply: "I couldn't read that message. Diri needs permission to view the channel and read its history.",
		};
	}
	if (anchor.author.bot) {
		return { status: "skipped", reply: "I start recaps from a member's message." };
	}
	if (!anchor.text) {
		return {
			status: "needs-detail",
			reply: "That message has no text I can use. If it already has text, enable the Message Content intent for Diri and react again.",
		};
	}

	const window = channelWindow(anchor, pagePosts(nearbyPayload));
	const reason = recapClarificationReason(anchor.text, anchor.author, attachmentCount(anchorPayload), nearbyEvidence(window.nearby));
	if (reason) return { status: "needs-detail", reply: reason };

	const prepared = prepareRecap(anchor.text, anchor.author, anchor.atMs, "verbatim");
	const editorialMode = editorialModeFor(prepared.editorialMode, nearbyFactLines(window).length > 0);
	const inference = editorialMode === "self-report" ? prepared.inference : null;
	return {
		status: "ready",
		fields: {
			editorialMode,
			inference,
			text: gatheredText(window, editorialMode),
			links: gatheredLinks(window, anchorMessageUrl(flag)),
			images: gatheredImages(window),
			authoredBy: formatReporter(anchor.author),
			submittedBy: formatReporter(flag.reactor),
		},
	};
}

function editorialModeFor(
	anchorMode: "verbatim" | "agentic" | "self-report",
	hasContributor: boolean,
): RecapEmailFields["editorialMode"] {
	switch (anchorMode) {
		case "self-report":
			return "self-report";
		case "verbatim":
		case "agentic":
			return hasContributor ? "agentic" : anchorMode;
		default: {
			const unreachable: never = anchorMode;
			return unreachable;
		}
	}
}

function channelWindow(anchor: MemberPost, posts: readonly MemberPost[]): ChannelWindow {
	const others = posts.filter((post) => post.messageId !== anchor.messageId);
	const before = walkAway(others.filter((post) => isBefore(post, anchor)), anchor.atMs, "before");
	const after = walkAway(others.filter((post) => !isBefore(post, anchor)), anchor.atMs, "after");
	let nearby = [...before, ...after];
	if (nearby.length > NEARBY_LIMIT - 1) {
		nearby = nearby
			.slice()
			.sort((left, right) => distanceRank(anchor, left, right))
			.slice(0, NEARBY_LIMIT - 1);
	}
	nearby.sort(comparePost);
	return { anchor, nearby };
}

function walkAway(posts: readonly MemberPost[], anchorAtMs: number, direction: "before" | "after"): MemberPost[] {
	const ordered = [...posts].sort((left, right) => direction === "before" ? comparePost(right, left) : comparePost(left, right));
	const kept: MemberPost[] = [];
	let cursor = anchorAtMs;
	for (const post of ordered) {
		const gap = direction === "before" ? cursor - post.atMs : post.atMs - cursor;
		if (gap > NEARBY_GAP_MS) break;
		kept.push(post);
		cursor = post.atMs;
	}
	return kept;
}

function isBefore(post: MemberPost, anchor: MemberPost): boolean {
	if (post.atMs !== anchor.atMs) return post.atMs < anchor.atMs;
	return compareSnowflake(post.messageId, anchor.messageId) < 0;
}

function comparePost(left: MemberPost, right: MemberPost): number {
	if (left.atMs !== right.atMs) return left.atMs < right.atMs ? -1 : 1;
	return compareSnowflake(left.messageId, right.messageId);
}

function distanceRank(anchor: MemberPost, left: MemberPost, right: MemberPost): number {
	const leftGap = Math.abs(left.atMs - anchor.atMs);
	const rightGap = Math.abs(right.atMs - anchor.atMs);
	if (leftGap !== rightGap) return leftGap - rightGap;
	return compareSnowflake(left.messageId, right.messageId);
}

function compareSnowflake(left: string, right: string): number {
	if (left === right) return 0;
	try {
		const leftId = BigInt(left);
		const rightId = BigInt(right);
		if (leftId < rightId) return -1;
		if (leftId > rightId) return 1;
		return 0;
	} catch {
		if (left < right) return -1;
		if (left > right) return 1;
		return 0;
	}
}

function nearbyFactLines(window: ChannelWindow): string[] {
	const lines: string[] = [];
	for (const post of window.nearby) {
		if (!postContributes(post)) continue;
		lines.push(factLine(post));
	}
	return lines;
}

function factLine(post: MemberPost): string {
	const name = memberName(post.author);
	if (textContributes(post.text)) return `${name}: ${post.text}`;
	return `${name}: ${post.images.map((image) => image.filename).join(", ")}`;
}

function gatheredText(window: ChannelWindow, mode: RecapEmailFields["editorialMode"]): string {
	switch (mode) {
		case "verbatim":
			return window.anchor.text;
		case "self-report":
		case "agentic": {
			const lines = nearbyFactLines(window);
			if (lines.length === 0) return window.anchor.text;
			return `${window.anchor.text}\n\n${lines.join("\n")}`;
		}
		default: {
			const unreachable: never = mode;
			throw new Error(`Unexpected editorial mode: ${String(unreachable)}`);
		}
	}
}

function gatheredLinks(window: ChannelWindow, anchorMessageUrl: string): string[] {
	const unique: string[] = [];
	const seen = new Set<string>();
	const push = (url: string) => {
		if (!url || seen.has(url)) return;
		seen.add(url);
		unique.push(url);
	};
	for (const url of window.anchor.links) push(url);
	push(anchorMessageUrl);
	for (const post of window.nearby) {
		for (const url of post.links) push(url);
	}
	return unique;
}

function gatheredImages(window: ChannelWindow): ImageRef[] {
	const refs: ImageRef[] = [];
	for (const image of window.anchor.images) {
		if (refs.length === MAX_IMAGES) return refs;
		refs.push(image);
	}
	for (const post of window.nearby) {
		for (const image of post.images) {
			if (refs.length === MAX_IMAGES) return refs;
			refs.push(image);
		}
	}
	return refs;
}

function nearbyEvidence(posts: readonly MemberPost[]): { text: string; images: number } | undefined {
	const contributing = posts.filter(postContributes);
	if (contributing.length === 0) return undefined;
	return {
		text: contributing.map((post) => post.text).filter(Boolean).join("\n"),
		images: contributing.reduce((count, post) => count + post.images.length, 0),
	};
}

function postContributes(post: MemberPost): boolean {
	return post.images.length > 0 || textContributes(post.text);
}

function textContributes(text: string): boolean {
	return noteHasResultOrUrl(text) || wordCount(text) >= CONTRIBUTING_WORDS;
}

function wordCount(text: string): number {
	return text.split(/\s+/).filter(Boolean).length;
}

function anchorMessageUrl(flag: RecapFlag): string {
	if (!/^\d{5,22}$/.test(flag.guildId)) return "";
	return `https://discord.com/channels/${flag.guildId}/${flag.channelId}/${flag.messageId}`;
}

function anchorPost(payload: unknown, flag: RecapFlag): MemberPost | null {
	if (!isRecord(payload)) return null;
	const text = messageText(payload.content);
	const parsed = typeof payload.timestamp === "string" ? Date.parse(payload.timestamp) : Number.NaN;
	return {
		messageId: flag.messageId,
		atMs: Number.isNaN(parsed) ? flag.nowMs : parsed,
		author: reporterFromPayload(payload.author),
		text,
		links: extractUrls(text),
		images: imageRefs(payload.attachments),
	};
}

function pagePosts(payload: unknown): MemberPost[] {
	if (!Array.isArray(payload)) return [];
	const posts: MemberPost[] = [];
	for (const item of payload) {
		const post = nearbyPost(item);
		if (post) posts.push(post);
	}
	return posts;
}

function nearbyPost(payload: unknown): MemberPost | null {
	if (!isRecord(payload)) return null;
	const author = reporterFromPayload(payload.author);
	if (author.bot) return null;
	if (typeof payload.timestamp !== "string") return null;
	const atMs = Date.parse(payload.timestamp);
	if (Number.isNaN(atMs)) return null;
	const text = messageText(payload.content);
	return {
		messageId: typeof payload.id === "string" ? payload.id : "",
		atMs,
		author,
		text,
		links: extractUrls(text),
		images: imageRefs(payload.attachments),
	};
}

function reporterFromPayload(author: unknown): Reporter {
	if (!isRecord(author)) return reporterFromUser({});
	return reporterFromUser({
		id: typeof author.id === "string" ? author.id : undefined,
		username: typeof author.username === "string" ? author.username : undefined,
		global_name: typeof author.global_name === "string" || author.global_name === null ? author.global_name : undefined,
		bot: author.bot === true,
	});
}

function attachmentCount(payload: unknown): number {
	if (!isRecord(payload) || !Array.isArray(payload.attachments)) return 0;
	return payload.attachments.length;
}

function imageRefs(attachments: unknown): ImageRef[] {
	if (!Array.isArray(attachments)) return [];
	const refs: ImageRef[] = [];
	for (const item of attachments) {
		if (!isRecord(item)) continue;
		const filename = typeof item.filename === "string" && item.filename ? item.filename : "attachment";
		const contentType = String(item.content_type || "").split(";")[0].trim().toLowerCase();
		const size = Number(item.size || 0);
		const url = typeof item.url === "string" ? item.url : "";
		if (!url || !IMAGE_CONTENT_TYPES.has(contentType) || size <= 0 || size > MAX_IMAGE_BYTES) continue;
		refs.push({ filename, content_type: contentType, size, url });
	}
	return refs;
}

function messageText(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (value === undefined || value === null) return "";
	return String(value).trim();
}

function extractUrls(text: string): string[] {
	const unique: string[] = [];
	const seen = new Set<string>();
	const matches = text.match(/https?:\/\/[^\s<>()"']+/gi) || [];
	for (const match of matches) {
		const cleaned = match.replace(/[),.;!?]+$/, "");
		if (!cleaned || seen.has(cleaned)) continue;
		seen.add(cleaned);
		unique.push(cleaned);
	}
	return unique;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
