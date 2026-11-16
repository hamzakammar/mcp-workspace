import { describe, it, expect, vi } from "vitest";
import { makeFakeSupabase, type SbCall } from "./fakeSupabase.js";

// Stateful sync_state table so we can check the notified set persists across runs.
let syncRows: Array<{ id: string; user_id: string; source: string; course_id: null; last_sync_at: string; cursor: any }> = [];
const sb = makeFakeSupabase((c: SbCall) => {
  if (c.table === "user_credentials") return { data: { host: "learn.uwaterloo.ca" } };
  if (c.table === "device_tokens") return { data: [] };
  if (c.table === "sync_state") {
    if (c.op === "select") return { data: syncRows[0] ?? null };
    if (c.op === "insert") { syncRows.push({ id: `row${syncRows.length + 1}`, ...(c.payload as any) }); return {}; }
    if (c.op === "update") {
      const id = c.filters.find((f) => f[1] === "id")?.[2];
      const row = syncRows.find((r) => r.id === id);
      if (row) Object.assign(row, c.payload);
      return {};
    }
  }
  return {};
});

let folders: Array<{ Id: number; Name: string; DueDate: string }> = [];
vi.mock("../../src/utils/supabase.js", () => ({ supabase: sb }));
vi.mock("../../src/client.js", () => ({
  D2LClient: class {
    async getMyEnrollments() {
      return { Items: [{ OrgUnit: { Id: 101, Name: "CS 101", Type: { Code: "Course Offering" } }, Access: { IsActive: true, CanAccess: true } }] };
    }
    async getNews() { return []; }
    async getDropboxFolders() { return folders; }
  },
}));
vi.mock("../../src/study/src/sync.js", () => ({ SyncTools: {} }));

const { diffNotifiedFolders, checkAndNotifyUpdates } = await import("../../src/api/push.js");

describe("diffNotifiedFolders", () => {
  const f = [{ Id: 1, Name: "A1" }, { Id: 2, Name: "A2" }];
  it("seeds on first run without notifying", () => {
    expect(diffNotifiedFolders(undefined, f)).toEqual({ toNotify: [], nextIds: ["1", "2"] });
  });
  it("only notifies unseen folder ids", () => {
    const r = diffNotifiedFolders(["1"], f);
    expect(r.toNotify.map((x) => x.Id)).toEqual([2]);
    expect(r.nextIds).toEqual(["1", "2"]);
  });
  it("does not re-notify already seen folders", () => {
    expect(diffNotifiedFolders(["1", "2"], f).toNotify).toEqual([]);
  });
});

describe("checkAndNotifyUpdates persistence", () => {
  it("persists the notified set in one sync_state row across runs", async () => {
    syncRows = [];
    const future = new Date(Date.now() + 7 * 864e5).toISOString();
    folders = [{ Id: 1, Name: "A1", DueDate: future }];

    expect((await checkAndNotifyUpdates("u1")).assignments).toBe(0); // first run seeds
    expect(syncRows).toHaveLength(1);
    expect(syncRows[0].cursor.notifiedAssignments).toEqual({ "101": ["1"] });

    expect((await checkAndNotifyUpdates("u1")).assignments).toBe(0); // nothing new
    expect(syncRows).toHaveLength(1); // updated in place, no duplicate row

    folders = [...folders, { Id: 2, Name: "A2", DueDate: future }];
    expect((await checkAndNotifyUpdates("u1")).assignments).toBe(1); // only the new one
    expect((await checkAndNotifyUpdates("u1")).assignments).toBe(0); // not re-pushed
    expect(syncRows).toHaveLength(1);
    expect(syncRows[0].cursor.notifiedAssignments).toEqual({ "101": ["1", "2"] });
  });
});
