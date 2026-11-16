/**
 * Minimal chainable Supabase query-builder mock for G6b tests.
 * Every builder call is recorded; awaiting the chain calls `resolve(call)`.
 */
export interface RecordedCall {
  table: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  payload?: unknown;
  options?: unknown;
  filters: Array<[string, ...unknown[]]>;
}

export function createSupabaseMock(resolve: (call: RecordedCall) => unknown) {
  const calls: RecordedCall[] = [];
  const from = (table: string) => {
    const call: RecordedCall = { table, op: 'select', filters: [] };
    let opSet = false;
    const builder: any = {};
    const setOp = (op: RecordedCall['op'], payload?: unknown, options?: unknown) => {
      if (!opSet) {
        call.op = op;
        call.payload = payload;
        call.options = options;
        opSet = true;
        calls.push(call);
      }
      return builder;
    };
    builder.select = (cols?: unknown, opts?: unknown) => {
      if (!opSet) setOp('select', cols, opts);
      else call.filters.push(['select', cols]);
      return builder;
    };
    builder.insert = (p: unknown) => setOp('insert', p);
    builder.update = (p: unknown) => setOp('update', p);
    builder.upsert = (p: unknown, o?: unknown) => setOp('upsert', p, o);
    builder.delete = () => setOp('delete');
    for (const f of ['eq', 'is', 'gt', 'in', 'order', 'limit']) {
      builder[f] = (...args: unknown[]) => {
        call.filters.push([f, ...args]);
        return builder;
      };
    }
    builder.maybeSingle = () => {
      call.filters.push(['maybeSingle']);
      return builder;
    };
    builder.then = (onOk: any, onErr: any) =>
      Promise.resolve().then(() => resolve(call)).then(onOk, onErr);
    return builder;
  };
  return { supabase: { from }, calls };
}

export function filterValue(call: RecordedCall, name: string, col?: string): unknown {
  const f = call.filters.find((x) => x[0] === name && (col === undefined || x[1] === col));
  return f ? (col === undefined ? f[1] : f[2]) : undefined;
}
