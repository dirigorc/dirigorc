import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { afterEach, describe, it, expect, vi } from "vitest";
import worker, { discordAttachments, routeDiscordInteraction, runDiscordBackgroundTask } from "../src/index";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Dirigo email ingest worker", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("explains POST-only usage (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(405);
		expect(await response.text()).toMatchInlineSnapshot(`
			"Send POST requests to submit a race report digest or calendar event.
			"
		`);
	});

	it("explains POST-only usage (integration style)", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(response.status).toBe(405);
		expect(await response.text()).toMatchInlineSnapshot(`
			"Send POST requests to submit a race report digest or calendar event.
			"
		`);
	});

	it("downloads a Discord /recap image option into the encoded attachment payload", async () => {
		const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(imageBytes, {
				status: 200,
				headers: { "content-type": "image/jpeg" },
			}),
		);
		const interaction = {
			data: {
				options: [{ name: "image1", value: "finish-photo" }],
				resolved: {
					attachments: {
						"finish-photo": {
							id: "finish-photo",
							filename: "karley-finish.jpg",
							content_type: "image/jpeg",
							size: imageBytes.length,
							url: "https://cdn.discord.test/karley-finish.jpg",
						},
					},
				},
			},
		};

		const summary = await discordAttachments(interaction);

		expect(fetchMock).toHaveBeenCalledWith("https://cdn.discord.test/karley-finish.jpg");
		expect(summary).toEqual({
			requested: 1,
			skipped: [],
			attachments: [
				{
					filename: "karley-finish.jpg",
					content_type: "image/jpeg",
					data: "/9j/2Q==",
				},
			],
		});
	});

	it("reports a failed Discord background submission", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
		const consoleMock = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const failure = new Error("GitHub dispatch failed: 403 Resource not accessible by personal access token");

		await runDiscordBackgroundTask(
			{ application_id: "discord-app", token: "interaction-token" },
			"event",
			() => Promise.reject(failure),
		);

		expect(consoleMock).toHaveBeenCalledWith(JSON.stringify({
			message: "Discord background submission failed",
			command: "event",
			error: failure.message,
		}));
		expect(fetchMock).toHaveBeenCalledWith(
			"https://discord.com/api/v10/webhooks/discord-app/interaction-token",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					content: `I received the event details, but the background update failed: ${failure.message}\n\nPlease retry /event.`,
					flags: 64,
				}),
			}),
		);
	});

	it("stops a slash recap past 3900 characters before dispatch", async () => {
		const github = mockGithub();
		const ctx = createExecutionContext();
		const response = await routeDiscordInteraction(
			{
				type: 2,
				application_id: "discord-app",
				token: "slash-token",
				data: { name: "recap", options: [{ name: "body", value: "A".repeat(3901) }] },
				member: { user: { id: "7", username: "seth" } },
			},
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		const payload = (await response.json()) as { type: number; data: { content: string } };
		expect(payload.type).toBe(4);
		expect(payload.data.content.indexOf("empty body")).toBeGreaterThanOrEqual(0);
		expect(payload.data.content.indexOf("empty body")).toBeLessThan(payload.data.content.indexOf("recap_file"));
		expect(github.calls.filter(isGithubDispatch)).toEqual([]);
	});

	it("defers an empty /recap with an image and follows up with Write recap", async () => {
		const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
		const github = mockGithub({ imageBytes });
		const ctx = createExecutionContext();
		const response = await routeDiscordInteraction(
			{
				type: 2,
				application_id: "discord-app",
				token: "slash-token",
				data: {
					name: "recap",
					options: [{ name: "image1", value: "finish-photo" }],
					resolved: {
						attachments: {
							"finish-photo": {
								id: "finish-photo",
								filename: "karley-finish.jpg",
								content_type: "image/jpeg",
								size: imageBytes.length,
								url: "https://cdn.discord.test/karley-finish.jpg",
							},
						},
					},
				},
				member: { user: { id: "7", username: "seth" } },
			},
			env,
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
		expect(github.calls.filter(isGithubDispatch)).toEqual([]);
		expect(github.calls.some((call) => call.url === "https://cdn.discord.test/karley-finish.jpg")).toBe(true);
		const followup = discordMessages(github.calls).at(-1);
		expect(followup?.components).toEqual([
			{
				type: 1,
				components: [
					expect.objectContaining({
						type: 2,
						label: "Write recap",
						custom_id: expect.stringMatching(/^recap_write:[a-z0-9-]+(?::[av])?$/),
					}),
				],
			},
		]);
		const blob = github.calls.find((call) => call.method === "POST" && call.url.includes("/git/blobs") && call.body?.includes("/9j/2Q=="));
		expect(blob).toBeTruthy();
	});

	it("dispatches a short recap modal with the body in client_payload", async () => {
		const body = "Seth Crockett finished the Beach to Beacon 10K in 42:10 on Saturday.";
		const github = mockGithub();
		const ctx = createExecutionContext();
		const response = await routeDiscordInteraction(recapModal("recap_modal_v1", body, "", "short-token"), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(((await response.json()) as { type: number }).type).toBe(4);
		const dispatches = github.calls.filter(isGithubDispatch);
		expect(dispatches).toHaveLength(1);
		expect(dispatches[0].url).toContain("https://api.github.com/");
		const payload = JSON.parse(dispatches[0].body || "{}") as { client_payload: { body?: string } };
		expect(payload.client_payload.body).toBe(body);
	});

	it("saves a full recap box and offers Add more and Finish", async () => {
		const body = "A".repeat(4000);
		const github = mockGithub();
		const ctx = createExecutionContext();
		const response = await routeDiscordInteraction(recapModal("recap_modal_v1", body, "https://results.example/race", "full-token"), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(((await response.json()) as { type: number }).type).toBe(5);
		expect(github.calls.filter(isGithubDispatch)).toEqual([]);
		const followup = discordMessages(github.calls).at(-1);
		expect(followup?.content).toContain("box is full");
		expect(followup?.components).toEqual([
			{
				type: 1,
				components: [
					expect.objectContaining({
						type: 2,
						label: "Add more",
						custom_id: expect.stringMatching(/^recap_more:[a-z0-9-]+:1(?::[A-Za-z0-9_-]+)?$/),
					}),
					expect.objectContaining({
						type: 2,
						label: "Finish",
						custom_id: expect.stringMatching(/^recap_done:[a-z0-9-]+$/),
					}),
				],
			},
		]);
		const draftPut = github.calls.find((call) => call.method === "PUT" && call.url.includes("/draft.json"));
		expect(decodedPut(draftPut!).content).toMatchObject({
			status: "open",
			parts: [body],
		});
		expect(github.calls.some((call) => call.method === "PUT" && call.url.includes("/payload.json"))).toBe(false);
	});

	it("finishes two recap parts once, without a dispatch body", async () => {
		const part1 = `${"Seth Crockett finished the Beach to Beacon 10K in 42:10. "}${"A".repeat(4000)}`.slice(0, 3999) + " ";
		const part2 = " The club celebrated afterward.";
		const github = mockGithub();
		const id = await saveRecapParts(github, part1, part2);
		const ctx = createExecutionContext();
		await routeDiscordInteraction(finishClick(id, "finish-token"), env, ctx);
		await waitOnExecutionContext(ctx);

		const dispatches = github.calls.filter(isGithubDispatch);
		expect(dispatches).toHaveLength(1);
		const sent = JSON.parse(dispatches[0].body || "{}") as {
			event_type: string;
			client_payload: {
				body?: string;
				source: string;
				command: string;
				editorial_mode: string;
				submitted_by: string;
				links: string[];
				has_attachments: boolean;
				discord_callback: { application_id: string; token: string };
				ingest: { branch: string; path: string };
			};
		};
		expect(sent.event_type).toBe("race-report-email");
		expect(sent.client_payload.body).toBeUndefined();
		expect(sent.client_payload).toMatchObject({
			source: "discord",
			command: "recap",
			editorial_mode: "verbatim",
			submitted_by: "Seth Crockett (42)",
			links: ["https://results.example/race"],
			has_attachments: false,
			discord_callback: { application_id: "discord-app", token: "finish-token" },
			ingest: {
				branch: `automation/email-ingest-${id}`,
				path: `tmp/email-ingest/${id}/payload.json`,
			},
		});
		const staged = decodedPut(github.calls.find((call) => call.method === "PUT" && call.url.includes("/payload.json"))!).content as {
			email: { body: string; text: string; status?: string };
		};
		expect(staged.email.body).toBe(part1 + part2);
		expect(staged.email.text).toBe(part1 + part2);
		expect(staged.email.status).toBeUndefined();
		const dispatching = draftWrites(github.calls).find((write) => write.draft.status === "dispatching");
		expect(dispatching?.sha).toEqual(expect.any(String));
		expect(dispatching?.sha?.length).toBeGreaterThan(0);

		const retry = createExecutionContext();
		await routeDiscordInteraction(finishClick(id, "second-finish-token"), env, retry);
		await waitOnExecutionContext(retry);
		expect(github.calls.filter(isGithubDispatch)).toHaveLength(1);
		expect(discordMessages(github.calls).at(-1)?.content).toContain("already in review");
	});

	it("returns a failed recap dispatch to open so Finish can retry", async () => {
		const opening = `${"Seth Crockett finished the Beach to Beacon 10K in 42:10. "}${"B".repeat(4000)}`.slice(0, 4000);
		const github = mockGithub({ failDispatch: true });
		const id = await saveRecapParts(github, opening, "TAIL");
		const ctx = createExecutionContext();
		await routeDiscordInteraction(finishClick(id, "finish-token"), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(github.calls.filter(isGithubDispatch)).toHaveLength(1);
		expect(draftWrites(github.calls).at(-1)?.draft.status).toBe("open");

		const storedFile = github.files.get(draftKey(github.files, id));
		const stored = JSON.parse(storedFile!.text) as { parts: string[] };
		stored.parts.push("EXTRA");
		storedFile!.text = JSON.stringify(stored, null, 2);

		github.failDispatch = false;
		const retry = createExecutionContext();
		await routeDiscordInteraction(finishClick(id, "retry-token"), env, retry);
		await waitOnExecutionContext(retry);
		expect(github.calls.filter(isGithubDispatch)).toHaveLength(2);
		expect(draftWrites(github.calls).at(-1)?.draft.status).toBe("dispatched");
		const payloads = github.calls.filter((call) => call.method === "PUT" && call.url.includes("/payload.json"));
		const staged = decodedPut(payloads.at(-1)!).content as { email: { body: string } };
		expect(staged.email.body).toBe(`${opening}TAILEXTRA`);
	});

	it("keeps the first write when a recap part update conflicts", async () => {
		const part1 = "C".repeat(4000);
		const github = mockGithub({ conflictOnce: true });
		const id = await saveRecapParts(github, part1, "SECOND");
		const ctx = createExecutionContext();
		await routeDiscordInteraction(finishClick(id, "finish-token"), env, ctx);
		await waitOnExecutionContext(ctx);

		const staged = decodedPut(github.calls.find((call) => call.method === "PUT" && call.url.includes("/payload.json"))!).content as {
			email: { body: string };
		};
		expect(staged.email.body).toBe(`${part1}KEPT`);
	});

	it("does not dispatch a recap that was already sent", async () => {
		const github = mockGithub();
		const id = await saveRecapParts(github, "D".repeat(4000), "MORE");
		const key = draftKey(github.files, id);
		const draft = github.files.get(key);
		const stored = JSON.parse(draft!.text) as { status: string };
		stored.status = "dispatching";
		draft!.text = JSON.stringify(stored, null, 2);
		const branch = key.slice(0, key.indexOf(":"));
		github.files.set(`${branch}:tmp/email-ingest/${id}/sent.json`, { sha: "sent-sha", text: "{\"sent\":true}" });

		const ctx = createExecutionContext();
		await routeDiscordInteraction(finishClick(id, "finish-token"), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(github.calls.filter(isGithubDispatch)).toEqual([]);
		expect(discordMessages(github.calls).at(-1)?.content).toContain("already sent");
	});

	it("keeps a leading space when a later recap slice is joined", async () => {
		const part1 = `${"A".repeat(3999)} `;
		const github = mockGithub();
		const ctx = createExecutionContext();
		const response = await routeDiscordInteraction(recapModal("recap_modal_v1", part1, "", "edge-token"), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(((await response.json()) as { type: number }).type).toBe(5);
		expect(github.calls.filter(isGithubDispatch)).toEqual([]);
		const draftPut = github.calls.find((call) => call.method === "PUT" && call.url.includes("/draft.json"));
		expect(decodedPut(draftPut!).content).toMatchObject({ parts: [part1] });
	});

	it("asks for a full name before finishing a long recap", async () => {
		const github = mockGithub();
		const opening = (`Dave O ${"A".repeat(4000)}`).slice(0, 4000);
		const id = await saveRecapParts(github, opening, "finished behind Dave O");
		const ctx = createExecutionContext();
		await routeDiscordInteraction(finishClick(id, "finish-token"), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(github.calls.filter(isGithubDispatch)).toEqual([]);
		expect(discordMessages(github.calls).at(-1)?.content).toContain("Dave Ouellette");
		expect(draftWrites(github.calls).at(-1)?.draft.status).toBe("open");
	});

	it("puts a saved photo on the finished recap", async () => {
		const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
		const github = mockGithub({ imageBytes });
		const opened = createExecutionContext();
		await routeDiscordInteraction(
			{
				type: 2,
				application_id: "discord-app",
				token: "slash-token",
				data: {
					name: "recap",
					options: [{ name: "image1", value: "finish-photo" }],
					resolved: {
						attachments: {
							"finish-photo": {
								id: "finish-photo",
								filename: "karley-finish.jpg",
								content_type: "image/jpeg",
								size: imageBytes.length,
								url: "https://cdn.discord.test/karley-finish.jpg",
							},
						},
					},
				},
				member: { user: { id: "7", username: "seth" } },
			},
			env,
			opened,
		);
		await waitOnExecutionContext(opened);
		const id = recapId(github.calls, "recap_write");
		const added = createExecutionContext();
		await routeDiscordInteraction(recapModal(`recap_part:${id}:0`, "Seth Crockett won the 10K in 42:10.", "", "part-token"), env, added);
		await waitOnExecutionContext(added);
		const finished = createExecutionContext();
		await routeDiscordInteraction(finishClick(id, "finish-token"), env, finished);
		await waitOnExecutionContext(finished);

		const staged = decodedPut(github.calls.find((call) => call.method === "PUT" && call.url.includes("/payload.json"))!).content as {
			email: { attachments: Array<{ filename: string; data: string }> };
		};
		expect(staged.email.attachments).toEqual([
			expect.objectContaining({ filename: "karley-finish.jpg", data: "/9j/2Q==" }),
		]);
	});

	it("refuses a publish click from anyone except the approver", async () => {
		const calls = mockReviewFetch(reviewPull());
		const ctx = createExecutionContext();
		const response = await routeDiscordInteraction(reviewClick("pr_publish:41", "1"), reviewEnv(), ctx);
		await waitOnExecutionContext(ctx);

		expect(await response.json()).toEqual({
			type: 4,
			data: { content: "You can't publish or hold this draft.", flags: 64 },
		});
		expect(calls).toEqual([]);
	});

	it("merges an automation recap when Seth presses Publish", async () => {
		const calls = mockReviewFetch(reviewPull());
		const ctx = createExecutionContext();
		const response = await routeDiscordInteraction(reviewClick("pr_publish:41", "1227055686295359519"), reviewEnv(), ctx);
		await waitOnExecutionContext(ctx);

		expect(await response.json()).toEqual({ type: 6 });
		const merge = calls.find((call) => call.url.endsWith("/pulls/41/merge"));
		expect(merge).toMatchObject({ method: "PUT", body: JSON.stringify({ merge_method: "merge", sha: "abc123" }) });
		const update = reviewUpdate(calls);
		expect(update.content).toContain("Published **Beach to Beacon**");
		expect(update.components).toEqual([]);
		expect(update.embeds).toEqual([{ title: "Beach to Beacon" }]);
	});

	it("merges a calendar draft and still allows Seth when the approver var is unset", async () => {
		const calls = mockReviewFetch(reviewPull({
			head: { ref: "automation/calendar-event-5", sha: "def456" },
			labels: [{ name: "automated calendar" }],
		}));
		const ctx = createExecutionContext();
		await routeDiscordInteraction(reviewClick("pr_publish:41", "1227055686295359519"), {
			GITHUB_TOKEN: "github-token",
			GITHUB_REPO: "dirigorc/dirigorc",
		}, ctx);
		await waitOnExecutionContext(ctx);

		const merge = calls.find((call) => call.url.endsWith("/pulls/41/merge"));
		expect(JSON.parse(merge?.body || "{}")).toEqual({ merge_method: "merge", sha: "def456" });
	});

	it("does not merge a pull request the automation did not open", async () => {
		const calls = mockReviewFetch(reviewPull({
			head: { ref: "cursor/discord-pr-approval", sha: "nope" },
			labels: [{ name: "automated update" }],
		}));
		const ctx = createExecutionContext();
		await routeDiscordInteraction(reviewClick("pr_publish:41", "1227055686295359519"), reviewEnv(), ctx);
		await waitOnExecutionContext(ctx);

		expect(calls.some((call) => call.url.endsWith("/merge"))).toBe(false);
		expect(reviewUpdate(calls).content).toContain("left that pull request alone");
		expect(reviewUpdate(calls).components).toEqual([]);
	});

	it("holds a draft with a GitHub comment and leaves it open", async () => {
		const calls = mockReviewFetch(reviewPull());
		const ctx = createExecutionContext();
		await routeDiscordInteraction(reviewClick("pr_hold:41", "1227055686295359519"), reviewEnv(), ctx);
		await waitOnExecutionContext(ctx);

		expect(calls.some((call) => call.url.endsWith("/merge"))).toBe(false);
		const comment = calls.find((call) => call.url.endsWith("/issues/41/comments"));
		expect(JSON.parse(comment?.body || "{}")).toEqual({
			body: "Held in Discord by Seth Crockett (1227055686295359519).",
		});
		expect(reviewUpdate(calls).content).toContain("Held. The draft stays open.");
		expect(reviewUpdate(calls).components).toEqual([]);
	});

	it("lets Crow publish when the approver var is unset", async () => {
		const calls = mockReviewFetch(reviewPull());
		const ctx = createExecutionContext();
		await routeDiscordInteraction(reviewClick("pr_publish:41", "459385898992140288"), {
			GITHUB_TOKEN: "github-token",
			GITHUB_REPO: "dirigorc/dirigorc",
		}, ctx);
		await waitOnExecutionContext(ctx);

		expect(calls.some((call) => call.method === "PUT" && call.url.endsWith("/pulls/41/merge"))).toBe(true);
	});

	it("tells the other reviewer when Seth publishes", async () => {
		const calls = mockReviewFetch(reviewPull());
		const ctx = createExecutionContext();
		await routeDiscordInteraction(
			reviewClick("pr_publish:41:777:888", "1227055686295359519"),
			{ ...reviewEnv(), DISCORD_BOT_TOKEN: "bot-token" },
			ctx,
		);
		await waitOnExecutionContext(ctx);

		const sibling = calls.find((call) => call.method === "PATCH" && call.url.endsWith("/channels/777/messages/888"));
		const body = JSON.parse(sibling?.body || "{}") as { content?: string; components?: unknown[] };
		expect(body.content).toContain("Seth Crockett published this.");
		expect(body.content).toContain("https://github.com/dirigorc/dirigorc/pull/41");
		expect(body.components).toEqual([]);
		expect(reviewUpdate(calls).content).toContain("Published **Beach to Beacon**");
	});

	it("leaves the other reviewer's buttons alone when GitHub rejects the merge", async () => {
		const calls = mockReviewFetch(reviewPull(), 405, "At least 1 approving review is required.");
		const ctx = createExecutionContext();
		await routeDiscordInteraction(
			reviewClick("pr_publish:41:777:888", "1227055686295359519"),
			{ ...reviewEnv(), DISCORD_BOT_TOKEN: "bot-token" },
			ctx,
		);
		await waitOnExecutionContext(ctx);

		expect(calls.some((call) => call.url.includes("/channels/777/messages/888") && call.method === "PATCH")).toBe(false);
	});

	it("leaves the buttons in place when GitHub rejects the merge", async () => {
		const calls = mockReviewFetch(reviewPull(), 405, "At least 1 approving review is required.");
		const ctx = createExecutionContext();
		await routeDiscordInteraction(reviewClick("pr_publish:41", "1227055686295359519"), reviewEnv(), ctx);
		await waitOnExecutionContext(ctx);

		const update = reviewUpdate(calls);
		expect(update.content).toContain("At least 1 approving review is required.");
		expect(update.components).toEqual([{ type: 1 }]);
	});
});

type FetchCall = { url: string; method: string; body?: string };

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.toString();
	return input.url;
}

function isGithubDispatch(call: FetchCall): boolean {
	return call.method === "POST" && call.url.includes("/dispatches");
}

function decodedPut(call: FetchCall): { sha?: string; content: unknown } {
	const body = JSON.parse(call.body || "{}") as { sha?: string; content?: string };
	return { sha: body.sha, content: JSON.parse(atob(body.content || "")) };
}

function draftWrites(calls: FetchCall[]): Array<{ sha?: string; draft: { status: string } }> {
	return calls
		.filter((call) => call.method === "PUT" && call.url.includes("/draft.json"))
		.map((call) => {
			const decoded = decodedPut(call);
			return { sha: decoded.sha, draft: decoded.content as { status: string } };
		});
}

function discordMessages(calls: FetchCall[]): Array<{ content?: string; components?: unknown[] }> {
	return calls
		.filter((call) => call.method === "POST" && call.url.includes("discord.com/api/") && call.body)
		.map((call) => JSON.parse(call.body || "{}") as { content?: string; components?: unknown[] });
}

function recapModal(customId: string, body: string, links: string, token: string) {
	return {
		type: 5,
		application_id: "discord-app",
		token,
		data: {
			custom_id: customId,
			components: [
				{ type: 1, components: [{ type: 4, custom_id: "body", value: body }] },
				{ type: 1, components: [{ type: 4, custom_id: "links", value: links }] },
				{ type: 1, components: [{ type: 4, custom_id: "polish", value: "no" }] },
			],
		},
		member: { user: { id: "1", global_name: "Modal User" } },
	};
}

function finishClick(id: string, token: string) {
	return {
		type: 3,
		application_id: "discord-app",
		token,
		data: { custom_id: `recap_done:${id}` },
		member: { user: { id: "42", global_name: "Seth Crockett" } },
	};
}

function draftKey(files: Map<string, { sha: string; text: string }>, id: string): string {
	const key = [...files.keys()].find((entry) => entry.endsWith(`tmp/email-ingest/${id}/draft.json`));
	if (!key) throw new Error(`missing draft ${id}`);
	return key;
}

async function saveRecapParts(
	github: { calls: FetchCall[] },
	part1: string,
	part2: string,
): Promise<string> {
	const opened = createExecutionContext();
	await routeDiscordInteraction(recapModal("recap_modal_v1", part1, "https://results.example/race", "modal-token"), env, opened);
	await waitOnExecutionContext(opened);
	const id = recapId(github.calls, "recap_done");
	const added = createExecutionContext();
	await routeDiscordInteraction(recapModal(`recap_part:${id}:1`, part2, "", "part-token"), env, added);
	await waitOnExecutionContext(added);
	return id;
}

function recapId(calls: FetchCall[], prefix: "recap_done" | "recap_write"): string {
	for (const message of discordMessages(calls)) {
		const rows = (message.components || []) as Array<{ components?: Array<{ custom_id?: string }> }>;
		for (const row of rows) {
			for (const component of row.components || []) {
				const match = new RegExp(`^${prefix}:([a-z0-9-]+)`).exec(component.custom_id || "");
				if (match) return match[1];
			}
		}
	}
	throw new Error(`missing ${prefix}`);
}

function mockGithub(options: { imageBytes?: Uint8Array; failDispatch?: boolean; conflictOnce?: boolean } = {}) {
	const files = new Map<string, { sha: string; text: string }>();
	const calls: FetchCall[] = [];
	let shaCounter = 0;
	let branchName = "";
	const blobs = new Map<string, string>();
	let conflictArmed = options.conflictOnce === true;
	const state = { calls, files, failDispatch: options.failDispatch === true };
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		const method = (init?.method || "GET").toUpperCase();
		const body = typeof init?.body === "string" ? init.body : undefined;
		calls.push({ url, method, body });
		if (url.startsWith("https://cdn.discord.test/")) {
			return new Response(options.imageBytes || new Uint8Array(), {
				status: 200,
				headers: { "content-type": "image/jpeg" },
			});
		}
		if (url.includes("discord.com/api/")) return new Response(null, { status: 204 });
		if (isGithubDispatch({ url, method, body })) {
			if (state.failDispatch) return new Response("nope", { status: 500 });
			return new Response(null, { status: 204 });
		}
		if (url.includes("api.github.com") && url.includes("/git/ref/heads/")) {
			return Response.json({ object: { sha: "base-sha" } });
		}
		if (url.includes("api.github.com") && url.includes("/git/refs") && method === "POST") {
			const payload = body ? (JSON.parse(body) as { ref?: string }) : {};
			branchName = String(payload.ref || "").replace(/^refs\/heads\//, "");
			return Response.json({ ref: "ok" }, { status: 201 });
		}
		if (url.includes("api.github.com") && url.includes("/git/blobs") && method === "POST") {
			const payload = body ? (JSON.parse(body) as { content?: string }) : {};
			const sha = `blob-${++shaCounter}`;
			blobs.set(sha, payload.content || "");
			return Response.json({ sha });
		}
		if (url.includes("api.github.com") && url.includes("/git/blobs/") && method === "GET") {
			const sha = decodeURIComponent(url.split("/git/blobs/")[1]?.split("?")[0] || "");
			const content = blobs.get(sha);
			if (content === undefined) return new Response("missing blob", { status: 404 });
			const binary = atob(content);
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
			return new Response(bytes);
		}
		if (url.includes("api.github.com") && url.includes("/git/commits/") && method === "GET") {
			return Response.json({ sha: "base-sha", tree: { sha: "tree-base" } });
		}
		if (url.includes("api.github.com") && url.includes("/git/trees") && method === "POST") {
			const payload = body ? (JSON.parse(body) as { tree?: Array<{ path: string; sha: string }> }) : {};
			for (const entry of payload.tree || []) {
				const content = blobs.get(entry.sha);
				if (content === undefined || !branchName) continue;
				files.set(`${branchName}:${entry.path}`, { sha: `sha-${++shaCounter}`, text: atob(content) });
			}
			return Response.json({ sha: "tree-next" });
		}
		if (url.includes("api.github.com") && url.includes("/git/commits") && method === "POST") {
			return Response.json({ sha: `commit-${++shaCounter}` });
		}
		if (url.includes("api.github.com") && url.includes("/git/refs/heads/") && method === "PATCH") {
			return Response.json({ ref: "ok" });
		}
		if (url.includes("api.github.com") && url.includes("/contents/")) {
			const path = contentsPath(url);
			const payload = body ? (JSON.parse(body) as { branch?: string; sha?: string; content?: string }) : {};
			const branch = method === "PUT" ? payload.branch || "" : new URL(url).searchParams.get("ref") || "";
			const key = `${branch}:${path}`;
			if (method === "GET") {
				const file = files.get(key);
				if (!file) return Response.json({ message: "Not Found" }, { status: 404 });
				return Response.json({ sha: file.sha, content: btoa(file.text), encoding: "base64" });
			}
			if (method === "PUT") {
				const existing = files.get(key);
				if (conflictArmed && path.endsWith("draft.json") && existing) {
					conflictArmed = false;
					const parsed = JSON.parse(existing.text) as { parts: string[] };
					parsed.parts[1] = "KEPT";
					existing.text = JSON.stringify(parsed, null, 2);
					existing.sha = `sha-${++shaCounter}`;
					return Response.json({ message: "conflict" }, { status: 409 });
				}
				if (existing && payload.sha !== existing.sha) {
					return Response.json({ message: "conflict" }, { status: 409 });
				}
				const sha = `sha-${++shaCounter}`;
				files.set(key, { sha, text: atob(payload.content || "") });
				return Response.json({ content: { sha } }, { status: existing ? 200 : 201 });
			}
		}
		return new Response(`unexpected fetch ${method} ${url}`, { status: 500 });
	});
	return state;
}

function contentsPath(url: string): string {
	const pathname = new URL(url).pathname;
	const marker = "/contents/";
	return decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length));
}

function reviewEnv() {
	return {
		GITHUB_TOKEN: "github-token",
		GITHUB_REPO: "dirigorc/dirigorc",
		DISCORD_PR_APPROVER_IDS: "1227055686295359519",
	};
}

function reviewPull(overrides: Record<string, unknown> = {}) {
	return {
		number: 41,
		state: "open",
		merged: false,
		title: "Beach to Beacon",
		html_url: "https://github.com/dirigorc/dirigorc/pull/41",
		base: { ref: "main" },
		head: { ref: "automation/race-report-99", sha: "abc123" },
		labels: [{ name: "automated update" }, { name: "content" }],
		...overrides,
	};
}

function reviewClick(customId: string, userId: string) {
	return {
		type: 3,
		application_id: "discord-app",
		token: "review-token",
		data: { custom_id: customId },
		user: { id: userId, username: "seth", global_name: "Seth Crockett" },
		message: { embeds: [{ title: "Beach to Beacon" }], components: [{ type: 1 }] },
	};
}

function mockReviewFetch(pull: Record<string, unknown>, mergeStatus = 200, mergeMessage = "merged") {
	const calls: FetchCall[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = requestUrl(input);
		const method = (init?.method || "GET").toUpperCase();
		const body = typeof init?.body === "string" ? init.body : undefined;
		calls.push({ url, method, body });
		if (url.includes("/pulls/41/merge")) {
			return Response.json({ message: mergeMessage, merged: mergeStatus < 300 }, { status: mergeStatus });
		}
		if (url.includes("/issues/41/comments")) return Response.json({ id: 1 }, { status: 201 });
		if (url.includes("discord.com")) return new Response(null, { status: 200 });
		if (url.endsWith("/pulls/41")) return Response.json(pull, { status: 200 });
		return new Response("missing", { status: 404 });
	});
	return calls;
}

function reviewUpdate(calls: FetchCall[]): { content?: string; components?: unknown[]; embeds?: unknown[] } {
	const update = calls.find((call) => call.method === "PATCH" && call.url.includes("/messages/@original"));
	if (!update?.body) throw new Error("missing Discord review update");
	return JSON.parse(update.body) as { content?: string; components?: unknown[]; embeds?: unknown[] };
}
