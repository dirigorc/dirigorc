import { createHash } from "node:crypto";
import { loadDiscordContract, type DiscordContract } from "./discord-contract";
import {
	DISCORD_INTERACTION_APPLICATION_COMMAND,
	DISCORD_INTERACTION_MESSAGE_COMPONENT,
	DISCORD_INTERACTION_MODAL_SUBMIT,
	DISCORD_RESPONSE_DEFERRED_UPDATE_MESSAGE,
	DISCORD_RESPONSE_MODAL,
	type DiscordInteraction,
	discordAck,
	discordDeferredAck,
	discordFollowup,
	discordModalField,
	discordOption,
	discordSubmittedBy,
	discordUser,
} from "./discord-reply";
import {
	base64ToText,
	dispatchToGitHub,
	githubFetch,
	type CorrectionWire,
	type EmailPayload,
	type WorkerEnv,
} from "./dispatch";
import { chooseRevision, describeRevision, revisionScore, type RevisionCandidate } from "./revise-when";

type Snowflake = string & { readonly __brand: "Snowflake" };

type Reviewer = {
	id: Snowflake;
	submittedBy: string;
	displayName: string;
};

type ReviewMessageRef = {
	channelId: Snowflake;
	messageId: Snowflake;
};

type Instruction = string & { readonly __brand: "Instruction" };

type PostPath = `_posts/${string}.md` & { readonly __brand: "PostPath" };
type EventPath = `_events/${string}.md` & { readonly __brand: "EventPath" };

type SitePage =
	| { kind: "post"; path: PostPath }
	| { kind: "event"; path: EventPath };

type AutomationHead = string & { readonly __brand: "AutomationHead" };

type Correction =
	| {
		kind: "draft";
		reviewer: Reviewer;
		pullNumber: number;
		head: AutomationHead;
		pages: readonly SitePage[];
		instruction: Instruction;
		messages: readonly ReviewMessageRef[];
	}
	| {
		kind: "published";
		submittedBy: string;
		page: SitePage;
		instruction: Instruction;
	};

type TargetQuery =
	| { kind: "pull"; pullNumber: number }
	| { kind: "post"; path: PostPath }
	| { kind: "event-file"; path: EventPath }
	| { kind: "stem"; stem: string }
	| { kind: "calendar-anchor"; date: string; titleSlug: string }
	| { kind: "described"; text: string };

type ReviewControl =
	| { kind: "decision"; action: "publish" | "hold"; pullNumber: number; sibling?: ReviewMessageRef }
	| { kind: "revise"; pullNumber: number; messages: readonly ReviewMessageRef[] };

type PrReviewAction = "publish" | "hold";

type PrReviewKind = "published" | "held" | "already" | "closed" | "ignored";

interface PrReviewActionRequest {
	action: PrReviewAction;
	pullNumber: number;
	siblingChannelId?: string;
	siblingMessageId?: string;
}

interface PrReviewOutcome {
	content: string;
	clearButtons: boolean;
	kind?: PrReviewKind;
}

interface GitHubPull {
	state?: string;
	merged?: boolean;
	title?: string;
	html_url?: string;
	body?: string;
	number?: number;
	base?: { ref?: string };
	head?: { ref?: string; sha?: string };
	labels?: Array<{ name?: string }>;
}

const DEFAULT_PR_APPROVER_IDS = ["1227055686295359519", "459385898992140288"];
const AUTOMATION_PR_HEAD = /^automation\/(?:race-report|calendar-event)-\d+$/;
const POST_FILE = /^_posts\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;
const EVENT_FILE = /^_events\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;
const CUSTOM_ID_MAX = 100;

type DiscordCallback = { applicationId: string; token: string };

export async function handleReviewInteraction(
	interaction: DiscordInteraction,
	env: WorkerEnv,
	ctx: ExecutionContext,
): Promise<Response | null> {
	const contract = loadDiscordContract();
	if (interaction.type === DISCORD_INTERACTION_MESSAGE_COMPONENT) {
		return reviewButton(interaction, env, ctx, contract);
	}
	if (interaction.type === DISCORD_INTERACTION_MODAL_SUBMIT) {
		return reviewModal(interaction, env, ctx, contract);
	}
	if (interaction.type === DISCORD_INTERACTION_APPLICATION_COMMAND) {
		const correction = contract.commands.find((command) => command.dispatch === null);
		if (correction && interaction.data?.name === correction.name) return reviewCommand(interaction, env, ctx);
	}
	return null;
}

function reviewButton(
	interaction: DiscordInteraction,
	env: WorkerEnv,
	ctx: ExecutionContext,
	contract: DiscordContract,
): Response | null {
	const control = parseReviewControl(interaction.data?.custom_id || "", contract);
	if (!control) return null;
	const reviewer = requireReviewer(interaction, env);
	if (reviewer instanceof Response) return reviewer;
	if (control.kind === "decision") {
		return startPrReview(interaction, env, ctx, reviewer, {
			action: control.action,
			pullNumber: control.pullNumber,
			siblingChannelId: control.sibling?.channelId,
			siblingMessageId: control.sibling?.messageId,
		});
	}
	const current = clickedMessage(interaction);
	if (!current) return discordAck("This review message is missing an id.");
	const messages = [
		current,
		...control.messages.filter((message) => message.channelId !== current.channelId || message.messageId !== current.messageId),
	];
	const prefix = contract.reviewActions.find((action) => action.modalPrefix)?.modalPrefix || "";
	const customId = modalCustomId(prefix, control.pullNumber, messages);
	if (!customId) return discordAck("That review button does not fit in a Discord id.");
	return reviseModal(customId);
}

function reviewModal(
	interaction: DiscordInteraction,
	env: WorkerEnv,
	ctx: ExecutionContext,
	contract: DiscordContract,
): Response | null {
	const parsed = parseReviseModal(interaction.data?.custom_id || "", contract);
	if (!parsed) return null;
	const reviewer = requireReviewer(interaction, env);
	if (reviewer instanceof Response) return reviewer;
	const instruction = parseInstruction(discordModalField(interaction, "change"));
	if (!instruction) return discordAck("Write one instruction, from 12 to 1000 characters.");
	ctx.waitUntil(runCorrection(interaction, env, async () => {
		const resolved = await resolveDraft(env, parsed.pullNumber, reviewer, instruction, parsed.messages);
		if ("reason" in resolved) return resolved.reason;
		const result = await applyCorrection(env, resolved, discordCallback(interaction));
		return correctionFollowup(env, result, parsed.pullNumber);
	}));
	return discordDeferredAck();
}

function reviewCommand(interaction: DiscordInteraction, env: WorkerEnv, ctx: ExecutionContext): Response {
	ctx.waitUntil(runCorrection(interaction, env, async () => {
		const repo = env.GITHUB_REPO || "dirigorc/dirigorc";
		const instruction = parseInstruction(String(discordOption(interaction, "change") || ""));
		if (!instruction) return "Write one instruction, from 12 to 1000 characters.";
		const query = parseTargetQuery(String(discordOption(interaction, "page") || ""), repo);
		if ("reason" in query) return query.reason;
		if (query.kind === "pull") {
			const reviewer = requireReviewer(interaction, env);
			if (reviewer instanceof Response) return "You can't review this draft.";
			const resolved = await resolveDraft(env, query.pullNumber, reviewer, instruction, []);
			if ("reason" in resolved) return resolved.reason;
			const result = await applyCorrection(env, resolved, discordCallback(interaction));
			return correctionFollowup(env, result, query.pullNumber);
		}
		const page = query.kind === "described"
			? await resolveDescribed(env, [query.text, instruction].filter(Boolean).join("\n"), Date.now())
			: await resolvePublishedPage(env, query);
		if ("reason" in page) return page.reason;
		const correction: Correction = {
			kind: "published",
			submittedBy: discordSubmittedBy(interaction).slice(0, 120),
			page,
			instruction,
		};
		const result = await applyCorrection(env, correction, discordCallback(interaction));
		return correctionFollowup(env, result);
	}));
	return discordDeferredAck();
}

function runCorrection(
	interaction: DiscordInteraction,
	env: WorkerEnv,
	task: () => Promise<string>,
): Promise<void> {
	return (async () => {
		try {
			await discordFollowup(interaction, await task());
		} catch (error) {
			const message = errorMessage(error);
			console.error(JSON.stringify({ message: "Correction failed", error: message }));
			try {
				await discordFollowup(interaction, `I could not start that correction: ${message}`);
			} catch (followupError) {
				console.error(JSON.stringify({ message: "Correction follow-up failed", error: errorMessage(followupError) }));
			}
		}
	})();
}

function correctionFollowup(
	env: WorkerEnv,
	result: { kind: "accepted"; branch: AutomationHead } | { kind: "unchanged"; url: string } | { kind: "refused"; reason: string },
	pullNumber?: number,
): string {
	if (result.kind === "refused") return result.reason;
	if (result.kind === "unchanged") return `That correction is already in review.\n${result.url}`;
	if (pullNumber) {
		const repo = env.GITHUB_REPO || "dirigorc/dirigorc";
		return `Correction in review.\nhttps://github.com/${repo}/pull/${pullNumber}`;
	}
	return "Correction sent for review.";
}

function discordCallback(interaction: DiscordInteraction): DiscordCallback | undefined {
	const applicationId = interaction.application_id || "";
	const token = interaction.token || "";
	if (!applicationId || !token) return undefined;
	return { applicationId, token };
}

function parseInstruction(raw: string): Instruction | null {
	const trimmed = raw.trim();
	if (!isInstruction(trimmed)) return null;
	return trimmed;
}

function isInstruction(value: string): value is Instruction {
	return value.length >= 12 && value.length <= 1000 && value === value.trim();
}

function requireReviewer(interaction: DiscordInteraction, env: WorkerEnv): Reviewer | Response {
	const id = discordUser(interaction).id || "";
	if (!isSnowflake(id) || !prApproverIds(env).has(id)) return discordAck("You can't review this draft.");
	const user = discordUser(interaction);
	return {
		id,
		submittedBy: discordSubmittedBy(interaction).slice(0, 120),
		displayName: user.global_name || user.username || "The other reviewer",
	};
}

function isSnowflake(value: string): value is Snowflake {
	return /^\d{1,20}$/.test(value);
}

function parseReviewControl(customId: string, contract: DiscordContract): ReviewControl | null {
	const action = contract.reviewActions.find((item) => customId.startsWith(`${item.customIdPrefix}:`));
	if (!action) return null;
	const parts = customId.slice(action.customIdPrefix.length + 1).split(":");
	if (parts.length !== 1 && parts.length !== 3) return null;
	if (!/^\d+$/.test(parts[0])) return null;
	const pullNumber = Number(parts[0]);
	if (!Number.isSafeInteger(pullNumber)) return null;
	let sibling: ReviewMessageRef | undefined;
	if (parts.length === 3) {
		if (!isSnowflake(parts[1]) || !isSnowflake(parts[2])) return null;
		sibling = { channelId: parts[1], messageId: parts[2] };
	}
	if (action.action === "publish" || action.action === "hold") {
		return sibling
			? { kind: "decision", action: action.action, pullNumber, sibling }
			: { kind: "decision", action: action.action, pullNumber };
	}
	if (!action.modalPrefix) return null;
	return { kind: "revise", pullNumber, messages: sibling ? [sibling] : [] };
}

function parseReviseModal(
	customId: string,
	contract: DiscordContract,
): { pullNumber: number; messages: readonly ReviewMessageRef[] } | null {
	const action = contract.reviewActions.find((item) => item.modalPrefix);
	if (!action?.modalPrefix || !customId.startsWith(`${action.modalPrefix}:`)) return null;
	if (customId.length > CUSTOM_ID_MAX) return null;
	const parts = customId.slice(action.modalPrefix.length + 1).split(":");
	if (parts.length !== 3 && parts.length !== 5) return null;
	if (!/^\d+$/.test(parts[0]) || !Number.isSafeInteger(Number(parts[0]))) return null;
	if (!isSnowflake(parts[1]) || !isSnowflake(parts[2])) return null;
	const messages: ReviewMessageRef[] = [{ channelId: parts[1], messageId: parts[2] }];
	if (parts.length === 5) {
		if (!isSnowflake(parts[3]) || !isSnowflake(parts[4])) return null;
		messages.push({ channelId: parts[3], messageId: parts[4] });
	}
	return { pullNumber: Number(parts[0]), messages };
}

function parseTargetQuery(input: string, repo: string): TargetQuery | { reason: string } {
	const raw = input.trim();
	if (!raw) return { kind: "described", text: "" };
	if (/^https?:\/\//i.test(raw)) return parseUrl(raw, repo);
	if (raw.startsWith("_posts/") || raw.startsWith("_events/")) {
		const page = contentPath(raw);
		return page || { reason: "That file is not a post or calendar event." };
	}
	const stem = /^(\d{4}-\d{2}-\d{2}-[a-z0-9-]+)$/.exec(raw);
	if (stem) return { kind: "stem", stem: stem[1] };
	return { kind: "described", text: raw };
}

function parseUrl(raw: string, repo: string): TargetQuery | { reason: string } {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return { reason: "That link is not a dirigorc.com page." };
	}
	if (url.protocol !== "https:") return { reason: "That link is not a dirigorc.com page." };
	if (url.hostname === "github.com") {
		const match = new RegExp(`^/${escapeRegex(repo)}/pull/(\\d+)/?$`).exec(url.pathname);
		if (!match) return { reason: "That link is not a pull request in this repository." };
		return { kind: "pull", pullNumber: Number(match[1]) };
	}
	const host = url.hostname.toLowerCase();
	if (host !== "dirigorc.com" && host !== "www.dirigorc.com") return { reason: "That link is not a dirigorc.com page." };
	const path = url.pathname.replace(/\/+$/, "") || "/";
	if (path === "/calendar") {
		const anchor = decodeURIComponent(url.hash.replace(/^#/, ""));
		const match = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(anchor);
		if (!match?.[2]) return { reason: "That calendar link has no event anchor." };
		return { kind: "calendar-anchor", date: match[1], titleSlug: match[2] };
	}
	const parts = path.split("/").filter(Boolean);
	if (parts.length > 0 && parts[parts.length - 1].endsWith(".html")) {
		parts[parts.length - 1] = parts[parts.length - 1].slice(0, -".html".length);
	}
	if (parts.length !== 4 && parts.length !== 5) return { reason: "That page link is not an update or a calendar event." };
	const slug = parts[parts.length - 1];
	const day = parts[parts.length - 2];
	const month = parts[parts.length - 3];
	const year = parts[parts.length - 4];
	if (!/^\d{4}$/.test(year) || !/^\d{2}$/.test(month) || !/^\d{2}$/.test(day) || !/^[a-z0-9-]+$/.test(slug)) {
		return { reason: "That page link is not an update or a calendar event." };
	}
	if (parts.length === 5 && !/^[A-Za-z0-9-]+$/.test(parts[0])) {
		return { reason: "That page link is not an update or a calendar event." };
	}
	const file = `_posts/${year}-${month}-${day}-${slug}.md`;
	if (!isPostPath(file)) return { reason: "That page link is not an update or a calendar event." };
	return { kind: "post", path: file };
}

function contentPath(raw: string): TargetQuery | null {
	if (isPostPath(raw)) return { kind: "post", path: raw };
	if (isEventPath(raw)) return { kind: "event-file", path: raw };
	return null;
}

function isPostPath(value: string): value is PostPath {
	return POST_FILE.test(value);
}

function isEventPath(value: string): value is EventPath {
	return EVENT_FILE.test(value);
}

function correctionBranch(page: SitePage): AutomationHead {
	const digest = sha256Hex(page.path);
	const digits = (BigInt(`0x${digest}`) % (10n ** 15n)).toString().padStart(15, "0");
	const prefix = page.kind === "post" ? "automation/race-report-" : "automation/calendar-event-";
	const head = `${prefix}${digits}`;
	if (!isAutomationHead(head)) throw new Error("Correction branch is not an automation draft.");
	return head;
}

function isAutomationHead(value: string): value is AutomationHead {
	return AUTOMATION_PR_HEAD.test(value);
}

function correctionMarker(path: string, instructionHash: string): string {
	return `<!-- dirigo-correction: ${path} ${instructionHash} -->`;
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

async function resolveDescribed(
	env: WorkerEnv,
	text: string,
	nowMs: number,
): Promise<SitePage | { reason: string }> {
	const described = describeRevision(text, nowMs);
	if (!described.date && described.words.length === 0) return { reason: "Say which page to correct, or name a day like Saturday or Oct 31." };
	const ref = env.GITHUB_REF || "main";
	const candidates: RevisionCandidate[] = [];
	for (const name of (await listRepoDir(env, ref, "_events")).filter((item) => item.endsWith(".md"))) {
		const path = `_events/${name}`;
		if (!isEventPath(path)) continue;
		const markdown = await readRepoText(env, ref, path);
		if (markdown === null) continue;
		if (described.date && !eventOccursOn(markdown, described.date)) continue;
		const title = frontMatterTitle(markdown) || name.replace(/\.md$/, "");
		if (!described.date && revisionScore(title, described.words) === 0) continue;
		candidates.push({ kind: "event", path, title });
	}
	for (const name of (await listRepoDir(env, ref, "_posts")).filter((item) => item.endsWith(".md"))) {
		const fileDate = /^\d{4}-\d{2}-\d{2}/.exec(name)?.[0] || "";
		if (described.date && fileDate !== described.date) continue;
		if (!described.date && revisionScore(name, described.words) === 0) continue;
		const path = `_posts/${name}`;
		if (!isPostPath(path)) continue;
		const markdown = await readRepoText(env, ref, path);
		if (markdown === null) continue;
		const title = frontMatterTitle(markdown) || name.replace(/\.md$/, "").slice(11);
		candidates.push({ kind: "post", path, title });
	}
	const chosen = chooseRevision(candidates, described.words, described.date);
	if ("reason" in chosen) return chosen;
	switch (chosen.kind) {
		case "post":
			if (!isPostPath(chosen.path)) return { reason: "That file is not a post or calendar event." };
			return { kind: "post", path: chosen.path };
		case "event":
			if (!isEventPath(chosen.path)) return { reason: "That file is not a post or calendar event." };
			return { kind: "event", path: chosen.path };
		default: {
			const unreachable: never = chosen.kind;
			return { reason: `Unexpected page: ${String(unreachable)}` };
		}
	}
}

async function resolvePublishedPage(
	env: WorkerEnv,
	query: Exclude<TargetQuery, { kind: "pull" } | { kind: "described" }>,
): Promise<SitePage | { reason: string }> {
	const ref = env.GITHUB_REF || "main";
	switch (query.kind) {
		case "post":
		case "event-file": {
			const text = await readRepoText(env, ref, query.path);
			if (text === null) return { reason: "That file is not on the site." };
			return query.kind === "post" ? { kind: "post", path: query.path } : { kind: "event", path: query.path };
		}
		case "stem": {
			const postPath = `_posts/${query.stem}.md`;
			const eventPath = `_events/${query.stem}.md`;
			if (!isPostPath(postPath) || !isEventPath(eventPath)) return { reason: "That name is not a post or calendar event." };
			const post = await readRepoText(env, ref, postPath);
			const event = await readRepoText(env, ref, eventPath);
			const found = Number(post !== null) + Number(event !== null);
			if (found !== 1) return { reason: `${found} files match that name.` };
			if (post !== null) return { kind: "post", path: postPath };
			return { kind: "event", path: eventPath };
		}
		case "calendar-anchor": {
			const names = (await listRepoDir(env, ref, "_events")).filter((name) => name.endsWith(".md"));
			const dated = names.filter((name) => name.startsWith(`${query.date}-`));
			const matches = await calendarFilesMatchingTitle(env, ref, dated, query.titleSlug);
			const resolved = matches.length > 0
				? matches
				: await calendarFilesOccurringOn(env, ref, names.filter((name) => !name.startsWith(`${query.date}-`)), query.date, query.titleSlug);
			if (resolved.length !== 1) return { reason: `${resolved.length} calendar events match that anchor.` };
			return { kind: "event", path: resolved[0] };
		}
		default: {
			const unreachable: never = query;
			return unreachable;
		}
	}
}

async function resolveDraft(
	env: WorkerEnv,
	pullNumber: number,
	reviewer: Reviewer,
	instruction: Instruction,
	messages: readonly ReviewMessageRef[],
): Promise<Extract<Correction, { kind: "draft" }> | { reason: string }> {
	const loaded = await loadPull(env, pullNumber);
	if ("reason" in loaded) return loaded;
	const pull = loaded.pull;
	const url = pullUrl(env, pull, pullNumber);
	if (pull.merged) return { reason: `That draft is already on the site.\n${url}`.trim() };
	if (pull.state !== "open") return { reason: `That draft is not open.\n${url}`.trim() };
	const head = pull.head?.ref || "";
	if (!isAutomationDraft(pull, env.GITHUB_REF || "main") || !isAutomationHead(head)) {
		return { reason: "Discord can only correct recap and calendar drafts." };
	}
	const pages = await loadPullPages(env, pullNumber);
	if ("reason" in pages) return pages;
	if (pages.length === 0) return { reason: "That draft has no post or calendar event to correct." };
	return {
		kind: "draft",
		reviewer,
		pullNumber,
		head,
		pages,
		instruction,
		messages,
	};
}

async function applyCorrection(
	env: WorkerEnv,
	correction: Correction,
	callback?: DiscordCallback,
): Promise<
	| { kind: "accepted"; branch: AutomationHead }
	| { kind: "unchanged"; url: string }
	| { kind: "refused"; reason: string }
> {
	if (correction.kind === "draft") return applyDraftCorrection(env, correction, callback);
	return applyPublishedCorrection(env, correction, callback);
}

async function applyDraftCorrection(
	env: WorkerEnv,
	correction: Extract<Correction, { kind: "draft" }>,
	callback?: DiscordCallback,
): Promise<
	| { kind: "accepted"; branch: AutomationHead }
	| { kind: "unchanged"; url: string }
	| { kind: "refused"; reason: string }
> {
	const loaded = await loadPull(env, correction.pullNumber);
	if ("reason" in loaded) return { kind: "refused", reason: loaded.reason };
	const path = correction.pages.length === 1 ? correction.pages[0].path : "*";
	const marker = correctionMarker(path, sha256Hex(correction.instruction));
	const url = pullUrl(env, loaded.pull, correction.pullNumber);
	if ((loaded.pull.body || "").includes(marker)) return { kind: "unchanged", url };
	const mode = headMode(correction.head);
	await dispatchCorrection(env, correction, {
		instruction: correction.instruction,
		instructionHash: sha256Hex(correction.instruction),
		marker,
		branch: correction.head,
		path,
		readFrom: "branch",
		reviewMessages: correction.messages.map((message) => ({ channelId: message.channelId, messageId: message.messageId })),
		mode,
	}, callback);
	return { kind: "accepted", branch: correction.head };
}

async function applyPublishedCorrection(
	env: WorkerEnv,
	correction: Extract<Correction, { kind: "published" }>,
	callback?: DiscordCallback,
): Promise<
	| { kind: "accepted"; branch: AutomationHead }
	| { kind: "unchanged"; url: string }
	| { kind: "refused"; reason: string }
> {
	const branch = correctionBranch(correction.page);
	const instructionHash = sha256Hex(correction.instruction);
	const marker = correctionMarker(correction.page.path, instructionHash);
	const existing = await findOpenPull(env, branch);
	if (existing && (existing.body || "").includes(marker)) {
		return { kind: "unchanged", url: existing.html_url || `https://github.com/${env.GITHUB_REPO || "dirigorc/dirigorc"}/pull/${existing.number || ""}` };
	}
	const mode = correction.page.kind === "event" ? "calendar-event" : "race-report";
	await dispatchCorrection(env, correction, {
		instruction: correction.instruction,
		instructionHash,
		marker,
		branch,
		path: correction.page.path,
		readFrom: existing ? "branch" : "main",
		reviewMessages: [],
		mode,
	}, callback);
	return { kind: "accepted", branch };
}

async function dispatchCorrection(
	env: WorkerEnv,
	correction: Correction,
	wire: CorrectionWire,
	callback?: DiscordCallback,
): Promise<void> {
	const submittedBy = correction.kind === "draft" ? correction.reviewer.submittedBy : correction.submittedBy;
	const name = loadDiscordContract().commands.find((command) => command.dispatch === null)?.name || "revise";
	const email: EmailPayload = {
		source: "discord",
		command: wire.mode === "calendar-event" ? "event" : "recap",
		editorial_mode: "agentic",
		submitted_by: submittedBy,
		from: submittedBy,
		subject: `Discord /${name}`,
		text: correction.instruction,
		body: correction.instruction,
		raw: "",
		links: [],
		correction: wire,
		discord_application_id: callback?.applicationId || "",
		discord_interaction_token: callback?.token || "",
	};
	await dispatchToGitHub(env, email, {
		eventType: wire.mode === "calendar-event" ? "calendar-event-email" : "race-report-email",
		correction: wire,
	});
}

function headMode(head: AutomationHead): "race-report" | "calendar-event" {
	return head.startsWith("automation/calendar-event-") ? "calendar-event" : "race-report";
}

function clickedMessage(interaction: DiscordInteraction): ReviewMessageRef | null {
	const channelId = interaction.channel_id || "";
	const messageId = interaction.message?.id || "";
	if (!isSnowflake(channelId) || !isSnowflake(messageId)) return null;
	return { channelId, messageId };
}

function modalCustomId(prefix: string, pullNumber: number, messages: readonly ReviewMessageRef[]): string | null {
	const current = messages[0];
	if (!prefix || !current) return null;
	let customId = `${prefix}:${pullNumber}:${current.channelId}:${current.messageId}`;
	const sibling = messages[1];
	if (sibling) customId += `:${sibling.channelId}:${sibling.messageId}`;
	if (customId.length > CUSTOM_ID_MAX) return null;
	return customId;
}

function reviseModal(customId: string): Response {
	return new Response(JSON.stringify({
		type: DISCORD_RESPONSE_MODAL,
		data: {
			custom_id: customId,
			title: "Revise",
			components: [{
				type: 1,
				components: [{
					type: 4,
					custom_id: "change",
					label: "What should change?",
					style: 2,
					min_length: 12,
					max_length: 1000,
					required: true,
				}],
			}],
		},
	}), { headers: { "content-type": "application/json" } });
}

async function calendarFilesMatchingTitle(
	env: WorkerEnv,
	ref: string,
	names: readonly string[],
	titleSlug: string,
): Promise<EventPath[]> {
	const matches: EventPath[] = [];
	for (const name of names) {
		const path = `_events/${name}`;
		if (!isEventPath(path)) continue;
		const text = await readRepoText(env, ref, path);
		if (text !== null && jekyllSlug(frontMatterTitle(text)) === titleSlug) matches.push(path);
	}
	return matches;
}

// A later week of a recurring series keeps the series file. The calendar card's
// anchor uses that week's date, the same way calendar/index.html decides which
// weeks to show.
async function calendarFilesOccurringOn(
	env: WorkerEnv,
	ref: string,
	names: readonly string[],
	iso: string,
	titleSlug: string,
): Promise<EventPath[]> {
	const matches: EventPath[] = [];
	for (const name of names) {
		const path = `_events/${name}`;
		if (!isEventPath(path)) continue;
		const text = await readRepoText(env, ref, path);
		if (text === null || jekyllSlug(frontMatterTitle(text)) !== titleSlug) continue;
		if (eventOccursOn(text, iso)) matches.push(path);
	}
	return matches;
}

function eventOccursOn(markdown: string, iso: string): boolean {
	const block = frontMatterBlock(markdown);
	if (block === null) return false;
	const start = isoDate(frontMatterValue(block, "date"));
	if (!start || skipDates(block).has(iso)) return false;
	if (start === iso) return true;
	const end = isoDate(frontMatterValue(block, "end_date"));
	if (!end || !frontMatterValue(block, "recurrence")) return false;
	if (iso < start || iso > end) return false;
	return weekday(iso) === weekday(start);
}

function frontMatterBlock(markdown: string): string | null {
	const lines = markdown.split("\n");
	if (lines[0]?.trim() !== "---") return null;
	const body: string[] = [];
	for (const line of lines.slice(1)) {
		if (line.trim() === "---") return body.join("\n");
		body.push(line.replace(/\r$/, ""));
	}
	return null;
}

function frontMatterValue(block: string, key: string): string {
	const match = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(block);
	if (!match) return "";
	return unquote(match[1].trim());
}

function isoDate(value: string): string {
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
	return match?.[1] ?? "";
}

function skipDates(block: string): Set<string> {
	const dates = new Set<string>();
	let inList = false;
	for (const line of block.split("\n")) {
		if (/^skip_dates:\s*$/.test(line)) {
			inList = true;
			continue;
		}
		if (!inList) continue;
		if (/^\S/.test(line)) break;
		const item = /^\s*-\s+(.+?)\s*$/.exec(line);
		if (!item) continue;
		const iso = isoDate(unquote(item[1].trim()));
		if (iso) dates.add(iso);
	}
	return dates;
}

function weekday(iso: string): number {
	const [year, month, day] = iso.split("-").map((part) => Number(part));
	return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

// Jekyll's default slugify, the same filter _includes/calendar-event-card.html uses for the anchor.
function jekyllSlug(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function frontMatterTitle(markdown: string): string {
	const lines = markdown.split("\n");
	if (lines[0]?.trim() !== "---") return "";
	for (const line of lines.slice(1)) {
		if (line.trim() === "---") break;
		const match = /^title:\s*(.*)$/.exec(line);
		if (!match) continue;
		return unquote(match[1].trim());
	}
	return "";
}

function unquote(value: string): string {
	if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
		try {
			const parsed: unknown = JSON.parse(value);
			return typeof parsed === "string" ? parsed : value.slice(1, -1);
		} catch {
			return value.slice(1, -1);
		}
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
	return value;
}

function pullUrl(env: WorkerEnv, pull: GitHubPull, pullNumber: number): string {
	if (pull.html_url) return pull.html_url;
	return `https://github.com/${env.GITHUB_REPO || "dirigorc/dirigorc"}/pull/${pullNumber}`;
}

async function loadPull(env: WorkerEnv, pullNumber: number): Promise<{ pull: GitHubPull } | { reason: string }> {
	const loaded = await githubFetch(env, `/pulls/${pullNumber}`);
	if (loaded.status === 404) return { reason: "That pull request does not exist." };
	if (loaded.status < 200 || loaded.status >= 300) {
		return { reason: `I could not open the draft: ${githubErrorMessage(loaded.text, loaded.status)}` };
	}
	const pull = asGitHubPull(loaded.text);
	if (!pull) return { reason: "I could not read the draft from GitHub, so I left it open." };
	return { pull };
}

async function loadPullPages(env: WorkerEnv, pullNumber: number): Promise<SitePage[] | { reason: string }> {
	const loaded = await githubFetch(env, `/pulls/${pullNumber}/files?per_page=100`);
	if (loaded.status < 200 || loaded.status >= 300) {
		return { reason: `I could not list the draft files: ${githubErrorMessage(loaded.text, loaded.status)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(loaded.text);
	} catch {
		return { reason: "I could not read the draft files." };
	}
	if (!Array.isArray(parsed)) return { reason: "I could not read the draft files." };
	const pages: SitePage[] = [];
	for (const file of parsed) {
		if (!isRecord(file) || typeof file.filename !== "string") continue;
		if (isPostPath(file.filename)) pages.push({ kind: "post", path: file.filename });
		else if (isEventPath(file.filename)) pages.push({ kind: "event", path: file.filename });
	}
	return pages;
}

async function findOpenPull(env: WorkerEnv, branch: AutomationHead): Promise<GitHubPull | null> {
	const repo = env.GITHUB_REPO || "dirigorc/dirigorc";
	const owner = repo.split("/")[0] || repo;
	const loaded = await githubFetch(env, `/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=10`);
	if (loaded.status < 200 || loaded.status >= 300) {
		throw new Error(`GitHub API failed: ${loaded.status} ${loaded.text}`);
	}
	return pullsFrom(loaded.text).find((pull) => pull.head?.ref === branch && pull.state === "open" && !pull.merged) || null;
}

async function readRepoText(env: WorkerEnv, ref: string, path: string): Promise<string | null> {
	const result = await githubFetch(env, `/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(ref)}`);
	if (result.status === 404) return null;
	if (result.status < 200 || result.status >= 300) throw new Error(`GitHub API failed: ${result.status} ${result.text}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.text);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || typeof parsed.content !== "string") return null;
	return base64ToText(parsed.content);
}

async function listRepoDir(env: WorkerEnv, ref: string, path: string): Promise<string[]> {
	const result = await githubFetch(env, `/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(ref)}`);
	if (result.status === 404) return [];
	if (result.status < 200 || result.status >= 300) throw new Error(`GitHub API failed: ${result.status} ${result.text}`);
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.text);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const names: string[] = [];
	for (const entry of parsed) {
		if (!isRecord(entry) || entry.type !== "file" || typeof entry.name !== "string") continue;
		names.push(entry.name);
	}
	return names;
}

function encodeRepoPath(path: string): string {
	return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function prApproverIds(env: WorkerEnv): Set<string> {
	const configured = (env.DISCORD_PR_APPROVER_IDS || "")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => /^\d+$/.test(value));
	return new Set(configured.length > 0 ? configured : DEFAULT_PR_APPROVER_IDS);
}

function siblingNotice(actor: string, outcome: PrReviewOutcome): string | null {
	if (!outcome.clearButtons || !outcome.kind) return null;
	const url = outcome.content.match(/\n(https:\/\/\S+)$/)?.[1];
	const suffix = url ? `\n${url}` : "";
	switch (outcome.kind) {
		case "published":
			return clipDiscordContent(`${actor} published this. It will show up on the site after the next deploy.${suffix}`);
		case "held":
			return clipDiscordContent(`${actor} held this. The draft stays open.${suffix}`);
		case "already":
			return clipDiscordContent(`This is already on the site.${suffix}`);
		case "closed":
			return clipDiscordContent(`This draft is already closed.${suffix}`);
		case "ignored":
			return clipDiscordContent(`That pull request was left alone. Discord can only publish recap and calendar drafts.${suffix}`);
		default: {
			const unreachable: never = outcome.kind;
			return unreachable;
		}
	}
}

function clipDiscordContent(value: string): string {
	if (value.length <= 2000) return value;
	return `${value.slice(0, 1999)}…`;
}

function githubErrorMessage(text: string, status: number): string {
	if (!text) return `GitHub returned ${status}.`;
	try {
		const parsed: unknown = JSON.parse(text);
		if (isRecord(parsed) && typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
	} catch {
		return text.slice(0, 300);
	}
	return text.slice(0, 300);
}

function asGitHubPull(text: string): GitHubPull | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? pullFromRecord(parsed) : null;
	} catch {
		return null;
	}
}

function pullsFrom(text: string): GitHubPull[] {
	try {
		const parsed: unknown = JSON.parse(text);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(isRecord).map(pullFromRecord);
	} catch {
		return [];
	}
}

function pullFromRecord(parsed: Record<string, unknown>): GitHubPull {
	const base = isRecord(parsed.base) && typeof parsed.base.ref === "string" ? { ref: parsed.base.ref } : undefined;
	const head = isRecord(parsed.head)
		? {
			ref: typeof parsed.head.ref === "string" ? parsed.head.ref : undefined,
			sha: typeof parsed.head.sha === "string" ? parsed.head.sha : undefined,
		}
		: undefined;
	const labels = Array.isArray(parsed.labels)
		? parsed.labels.filter(isRecord).map((label) => ({ name: typeof label.name === "string" ? label.name : undefined }))
		: undefined;
	return {
		state: typeof parsed.state === "string" ? parsed.state : undefined,
		merged: typeof parsed.merged === "boolean" ? parsed.merged : undefined,
		title: typeof parsed.title === "string" ? parsed.title : undefined,
		html_url: typeof parsed.html_url === "string" ? parsed.html_url : undefined,
		body: typeof parsed.body === "string" ? parsed.body : undefined,
		number: typeof parsed.number === "number" ? parsed.number : undefined,
		base,
		head,
		labels,
	};
}

function isAutomationDraft(pull: GitHubPull, baseBranch: string): boolean {
	const labels = new Set((pull.labels || []).map((label) => label.name || ""));
	const labeled = labels.has("automated update") || labels.has("automated calendar");
	return AUTOMATION_PR_HEAD.test(pull.head?.ref || "") && pull.base?.ref === baseBranch && labeled;
}

async function reviewPullRequest(env: WorkerEnv, action: PrReviewAction, pullNumber: number, actor: string): Promise<PrReviewOutcome> {
	if (!env.GITHUB_TOKEN) {
		return { content: "The site bot is missing a GitHub token, so I left the draft open.", clearButtons: false };
	}
	const loaded = await githubFetch(env, `/pulls/${pullNumber}`);
	if (loaded.status < 200 || loaded.status >= 300) {
		return {
			content: `I could not open the draft: ${githubErrorMessage(loaded.text, loaded.status)}`,
			clearButtons: false,
		};
	}
	const pull = asGitHubPull(loaded.text);
	if (!pull) {
		return { content: "I could not read the draft from GitHub, so I left it open.", clearButtons: false };
	}
	const url = typeof pull.html_url === "string" ? pull.html_url : "";
	const suffix = url ? `\n${url}` : "";
	if (!isAutomationDraft(pull, env.GITHUB_REF || "main")) {
		return {
			content: clipDiscordContent(`I left that pull request alone. Discord can only publish recap and calendar drafts.${suffix}`),
			clearButtons: true,
			kind: "ignored",
		};
	}
	if (pull.merged) {
		return { content: clipDiscordContent(`This is already on the site.${suffix}`), clearButtons: true, kind: "already" };
	}
	if (pull.state === "closed") {
		return { content: clipDiscordContent(`This draft is already closed.${suffix}`), clearButtons: true, kind: "closed" };
	}

	if (action === "hold") {
		const comment = await githubFetch(env, `/issues/${pullNumber}/comments`, {
			method: "POST",
			body: JSON.stringify({ body: `Held in Discord by ${actor}.` }),
		});
		if (comment.status < 200 || comment.status >= 300) {
			return {
				content: `I could not hold the draft: ${githubErrorMessage(comment.text, comment.status)}`,
				clearButtons: false,
			};
		}
		return { content: clipDiscordContent(`Held. The draft stays open.${suffix}`), clearButtons: true, kind: "held" };
	}

	const mergeBody: Record<string, string> = { merge_method: "merge" };
	if (pull.head?.sha) mergeBody.sha = pull.head.sha;
	const merged = await githubFetch(env, `/pulls/${pullNumber}/merge`, {
		method: "PUT",
		body: JSON.stringify(mergeBody),
	});
	if (merged.status < 200 || merged.status >= 300) {
		return {
			content: clipDiscordContent(`GitHub would not publish it: ${githubErrorMessage(merged.text, merged.status)}`),
			clearButtons: false,
		};
	}
	const title = pull.title?.trim();
	const published = title
		? `Published **${title}**. It will show up on the site after the next deploy.`
		: "Published. It will show up on the site after the next deploy.";
	return { content: clipDiscordContent(`${published}${suffix}`), clearButtons: true, kind: "published" };
}

async function editPrReviewMessage(interaction: DiscordInteraction, outcome: PrReviewOutcome): Promise<void> {
	const applicationId = interaction.application_id;
	const token = interaction.token;
	if (!applicationId || !token) return;
	const payload: Record<string, unknown> = {
		content: outcome.content,
		embeds: interaction.message?.embeds || [],
		components: outcome.clearButtons ? [] : interaction.message?.components || [],
	};
	const response = await fetch(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	if (!response.ok) {
		throw new Error(`Discord review update failed: ${response.status} ${await response.text()}`);
	}
}

async function editSiblingReviewMessage(env: WorkerEnv, channelId: string, messageId: string, content: string): Promise<void> {
	if (!env.DISCORD_BOT_TOKEN) {
		console.error(JSON.stringify({
			message: "Discord sibling review update skipped",
			reason: "DISCORD_BOT_TOKEN is not configured.",
		}));
		return;
	}
	const messageUrl = `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`;
	const headers = {
		Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
		"Content-Type": "application/json",
	};
	let embeds: unknown[] = [];
	const existing = await fetch(messageUrl, { headers });
	if (existing.ok) {
		try {
			const body: unknown = await existing.json();
			if (isRecord(body) && Array.isArray(body.embeds)) embeds = body.embeds;
		} catch {
			embeds = [];
		}
	}
	const response = await fetch(messageUrl, {
		method: "PATCH",
		headers,
		body: JSON.stringify({ content, components: [], embeds }),
	});
	if (!response.ok) {
		throw new Error(`Discord sibling review update failed: ${response.status} ${await response.text()}`);
	}
}

function startPrReview(
	interaction: DiscordInteraction,
	env: WorkerEnv,
	ctx: ExecutionContext,
	reviewer: Reviewer,
	review: PrReviewActionRequest,
): Response {
	const actor = reviewer.submittedBy;
	const actorName = reviewer.displayName;
	ctx.waitUntil((async () => {
		try {
			const outcome = await reviewPullRequest(env, review.action, review.pullNumber, actor);
			await editPrReviewMessage(interaction, outcome);
			const notice = siblingNotice(actorName, outcome);
			if (notice && review.siblingChannelId && review.siblingMessageId) {
				try {
					await editSiblingReviewMessage(env, review.siblingChannelId, review.siblingMessageId, notice);
				} catch (error) {
					console.error(JSON.stringify({
						message: "Discord sibling review update failed",
						pullNumber: review.pullNumber,
						error: errorMessage(error),
					}));
				}
			}
		} catch (error) {
			console.error(JSON.stringify({
				message: "Discord pull request review failed",
				pullNumber: review.pullNumber,
				error: errorMessage(error),
			}));
		}
	})());
	return new Response(JSON.stringify({ type: DISCORD_RESPONSE_DEFERRED_UPDATE_MESSAGE }), {
		headers: { "content-type": "application/json" },
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
