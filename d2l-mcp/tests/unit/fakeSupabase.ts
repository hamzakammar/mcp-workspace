/** Minimal chainable Supabase query-builder fake for G3 route tests. */
export type SbCall = {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
  filters: Array<[string, string, unknown]>;
  returning?: string;
};

export function makeFakeSupabase(respond: (call: SbCall) => { data?: unknown; error?: unknown }) {
  const calls: SbCall[] = [];
  const sb = {
    calls,
    from(table: string) {
      const call: SbCall = { table, op: "select", filters: [] };
      const builder: any = {
        select(cols?: string) {
          if (call.op === "select") call.payload = cols;
          else call.returning = cols;
          return builder;
        },
        insert(p: unknown) { call.op = "insert"; call.payload = p; return builder; },
        update(p: unknown) { call.op = "update"; call.payload = p; return builder; },
        upsert(p: unknown) { call.op = "upsert"; call.payload = p; return builder; },
        delete() { call.op = "delete"; return builder; },
        eq(c: string, v: unknown) { call.filters.push(["eq", c, v]); return builder; },
        is(c: string, v: unknown) { call.filters.push(["is", c, v]); return builder; },
        like(c: string, v: unknown) { call.filters.push(["like", c, v]); return builder; },
        order() { return builder; },
        limit() { return builder; },
        single() { return builder; },
        maybeSingle() { return builder; },
        then(onFul: any, onRej: any) {
          calls.push(call);
          const r = respond(call);
          return Promise.resolve({ data: r.data ?? null, error: r.error ?? null }).then(onFul, onRej);
        },
      };
      return builder;
    },
  };
  return sb;
}
