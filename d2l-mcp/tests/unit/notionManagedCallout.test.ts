/**
 * Regression guard for the managed-callout block shape.
 *
 * Notion's block API rejects a callout whose child blocks are attached as a sibling
 * `children` key on the block object (`{type:'callout', callout:{…}, children:[…]}`)
 * with a generic 400: "body.children[0].<type> should be defined, instead was
 * undefined". The children MUST be nested INSIDE the `callout` object as
 * `callout.children`. This bug silently 400'd every full-body sync — the append failed
 * and pages kept their stale/legacy bodies (no managed callout ever appeared).
 *
 * Verified empirically against the live Notion API: children-as-sibling → 400,
 * children-inside-callout → 200.
 */
import { describe, it, expect } from "vitest";
import { buildManagedCallout } from "../../src/study/notionClient.js";

describe("buildManagedCallout — child block nesting", () => {
  const kids = [
    { object: "block", type: "heading_2", heading_2: { rich_text: [{ text: { content: "📋 Assignments" } }] } },
    { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ text: { content: "⬜ A01" } }] } },
  ];

  it("nests children INSIDE the callout object, not as a sibling key", () => {
    const block = buildManagedCallout(kids) as any;
    expect(block.type).toBe("callout");
    // The whole point: children live under callout.children …
    expect(block.callout.children).toEqual(kids);
    // … and NOT as a top-level sibling (that shape is what Notion rejects with a 400).
    expect(block.children).toBeUndefined();
  });

  it("carries the stable managed marker so re-syncs can find and replace it", () => {
    const block = buildManagedCallout([]) as any;
    const marker = block.callout.rich_text.map((r: any) => r.text.content).join("");
    expect(marker).toContain("Horizon Live Sync");
    expect(block.callout.icon).toEqual({ emoji: "🔄" });
  });
});
