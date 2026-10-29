import { describe, expect, it } from "vitest";
import { chooseRevision, describeRevision, type RevisionCandidate } from "../src/revise-when";

const THURSDAY = Date.parse("2026-10-29T19:00:00Z");
const SUNDAY = Date.parse("2026-11-01T16:00:00Z");

describe("describeRevision", () => {
	it("reads a weekday, a loose date, and a weekend from the command day", () => {
		expect(describeRevision("meet this Saturday at Freeport", THURSDAY).date).toBe("2026-10-31");
		expect(describeRevision("the Saturday long run", THURSDAY).date).toBe("2026-10-31");
		expect(describeRevision("next Saturday", THURSDAY).date).toBe("2026-11-07");
		expect(describeRevision("tomorrow morning", THURSDAY).date).toBe("2026-10-30");
		expect(describeRevision("this weekend", THURSDAY).date).toBe("2026-10-31");
		expect(describeRevision("this weekend", SUNDAY).date).toBe("2026-10-31");
		expect(describeRevision("Oct 31", THURSDAY).date).toBe("2026-10-31");
		expect(describeRevision("10/31", THURSDAY).date).toBe("2026-10-31");
		expect(describeRevision("January 5", THURSDAY).date).toBe("2027-01-05");
		expect(describeRevision("On 2026-10-31 meet at Freeport", THURSDAY).date).toBe("2026-10-31");
	});

	it("keeps a distinctive name and drops the day and the filler", () => {
		expect(describeRevision("Meet at Freeport for the Payson run this Saturday", THURSDAY).words).toEqual(["freeport", "payson"]);
	});
});

describe("chooseRevision", () => {
	const payson: RevisionCandidate = { kind: "event", path: "_events/payson.md", title: "Saturday Long Run at Payson Park" };
	const bugLight: RevisionCandidate = { kind: "event", path: "_events/bug-light.md", title: "Saturday Long Run at Bug Light" };

	it("takes the only event on that day", () => {
		expect(chooseRevision([payson], [], "2026-10-31")).toEqual(payson);
	});

	it("uses the name when more than one event falls on the day", () => {
		expect(chooseRevision([payson, bugLight], ["payson"], "2026-10-31")).toEqual(payson);
		const reason = chooseRevision([payson, bugLight], ["freeport"], "2026-10-31");
		expect("reason" in reason && reason.reason).toContain("Payson Park");
		expect("reason" in reason && reason.reason).toContain("Bug Light");
	});

	it("asks for a day when the name is not unique", () => {
		const reason = chooseRevision([payson, bugLight], [], null);
		expect(reason).toEqual({ reason: "Say which page to correct, or name a day like Saturday or Oct 31." });
	});
});
