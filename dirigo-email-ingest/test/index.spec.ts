import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { afterEach, describe, it, expect, vi } from "vitest";
import worker, { discordAttachments } from "../src/index";

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
});
