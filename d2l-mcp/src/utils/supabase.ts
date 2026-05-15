import { createClient, SupabaseClient } from '@supabase/supabase-js';
import pg from 'pg';
const { Pool } = pg;

// Support multiple env var names for flexibility
const supabaseUrl = process.env.SUPABASE_URL || process.env.DATABASE_URL;
// Server-side backend must prefer service role to avoid RLS write failures.
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;

if (!supabaseUrl) {
  throw new Error('Missing database URL: SUPABASE_URL or DATABASE_URL required');
}

let supabase: any;

// If URL is postgresql:// (RDS), create a wrapper that uses pg pool
if (supabaseUrl.startsWith('postgresql://')) {
  const pool = new Pool({ 
    connectionString: supabaseUrl,
    ssl: { rejectUnauthorized: false } // RDS requires SSL
  });
  
  // Create a Supabase-like client wrapper using pg pool
  // This is a simplified version that handles the patterns used in the codebase
  supabase = {
    from: (table: string) => {
      return {
        select: (cols: string | { count?: string; head?: boolean } = '*', opts?: { count?: string; head?: boolean }) => {
          // Handle Supabase count pattern: .select("id", { count: "exact", head: true })
          // Options are passed as second parameter when first param is a string
          const options = (typeof cols === 'string' ? opts : cols) || {};
          const isCount = !!(options.count);
          const isHead = !!(options.head);
          
          let query: string;
          if (isCount) {
            // Count query: SELECT COUNT(*) FROM table
            query = `SELECT COUNT(*) as count FROM ${table}`;
          } else {
            const colStr = typeof cols === 'string' ? cols : '*';
            query = `SELECT ${colStr} FROM ${table}`;
          }
          
          const params: any[] = [];
          let paramIndex = 1;
          
          const builder: any = {
            eq: (col: string, val: any) => {
              if (params.length === 0) query += ` WHERE ${col} = $${paramIndex}`;
              else query += ` AND ${col} = $${paramIndex}`;
              params.push(val);
              paramIndex++;
              return builder;
            },
            ilike: (col: string, pattern: string) => {
              if (params.length === 0) query += ` WHERE ${col} ILIKE $${paramIndex}`;
              else query += ` AND ${col} ILIKE $${paramIndex}`;
              params.push(pattern);
              paramIndex++;
              return builder;
            },
            lte: (col: string, val: any) => {
              if (params.length === 0) query += ` WHERE ${col} <= $${paramIndex}`;
              else query += ` AND ${col} <= $${paramIndex}`;
              params.push(val);
              paramIndex++;
              return builder;
            },
            gte: (col: string, val: any) => {
              if (params.length === 0) query += ` WHERE ${col} >= $${paramIndex}`;
              else query += ` AND ${col} >= $${paramIndex}`;
              params.push(val);
              paramIndex++;
              return builder;
            },
            is: (col: string, val: any) => {
              // PostgreSQL's IS operator requires a literal NULL/TRUE/FALSE,
              // not a parameter. Inline the literal so `is("col", null)`
              // produces `IS NULL` instead of an invalid `IS $1`.
              const literal = val === null ? 'NULL' : val === true ? 'TRUE' : val === false ? 'FALSE' : null;
              if (literal === null) {
                throw new Error(`is() only supports null/true/false, got ${typeof val}`);
              }
              if (params.length === 0) query += ` WHERE ${col} IS ${literal}`;
              else query += ` AND ${col} IS ${literal}`;
              return builder;
            },
            limit: (n: number) => {
              query += ` LIMIT $${paramIndex}`;
              params.push(n);
              paramIndex++;
              // Return promise-like object that can be awaited
              return {
                then: async (resolve: any) => {
                  try {
                    const result = await pool.query(query, params);
                    if (isCount) {
                      // For count queries, return the count value
                      resolve({ 
                        data: isHead ? null : result.rows, 
                        count: parseInt(result.rows[0]?.count || '0', 10),
                        error: null 
                      });
                    } else {
                      resolve({ data: result.rows, error: null });
                    }
                  } catch (e: any) {
                    resolve({ data: null, error: e });
                  }
                }
              };
            },
            order: (col: string, opts: { ascending?: boolean } = {}) => {
              const dir = opts.ascending !== false ? 'ASC' : 'DESC';
              query += ` ORDER BY ${col} ${dir}`;
              // Return builder so limit() can be chained
              return builder;
            },
            then: async (resolve: any) => {
              try {
                const result = await pool.query(query, params);
                if (isCount) {
                  resolve({ 
                    data: isHead ? null : result.rows, 
                    count: parseInt(result.rows[0]?.count || '0', 10),
                    error: null 
                  });
                } else {
                  resolve({ data: result.rows, error: null });
                }
              } catch (e: any) {
                resolve({ data: null, error: e });
              }
            }
          };
          return builder;
        },
        insert: (data: any) => {
          const keys = Object.keys(data);
          const vals = Object.values(data);
          const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
          const insertQuery = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`;
          
          const selectBuilder = (cols: string = '*') => {
            const builder: any = {
              single: () => ({
                then: async (resolve: any) => {
                  const result = await pool.query(insertQuery.replace('RETURNING *', `RETURNING ${cols}`), vals);
                  resolve({ 
                    data: result.rows.length > 0 ? result.rows[0] : null, 
                    error: result.rows.length === 0 ? new Error('No rows returned') : null 
                  });
                }
              }),
              then: async (resolve: any) => {
                const result = await pool.query(insertQuery.replace('RETURNING *', `RETURNING ${cols}`), vals);
                resolve({ data: result.rows, error: null });
              }
            };
            return builder;
          };
          
          return {
            select: selectBuilder,
            then: async (resolve: any) => {
              const result = await pool.query(insertQuery, vals);
              resolve({ data: result.rows, error: null });
            }
          };
        },
        upsert: (data: any, opts?: any) => {
          const keys = Object.keys(data);
          const vals = Object.values(data);
          const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
          let onConflict = '';
          if (opts?.onConflict) {
            const conflictCols = Array.isArray(opts.onConflict) ? opts.onConflict.join(', ') : opts.onConflict;
            const updateCols = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
            onConflict = ` ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateCols}`;
          }
          
          return {
            then: async (resolve: any) => {
              const result = await pool.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})${onConflict} RETURNING *`, vals);
              resolve({ data: result.rows, error: null });
            }
          };
        },
        update: (data: any) => {
          const keys = Object.keys(data);
          const vals = Object.values(data);
          const setClause = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
          let updateQuery = `UPDATE ${table} SET ${setClause}`;
          const params: any[] = [...vals];
          let paramIndex = keys.length + 1;
          
          const builder: any = {
            eq: (col: string, val: any) => {
              if (params.length === keys.length) {
                // First WHERE clause
                updateQuery += ` WHERE ${col} = $${paramIndex}`;
              } else {
                // Additional AND clause
                updateQuery += ` AND ${col} = $${paramIndex}`;
              }
              params.push(val);
              paramIndex++;
              return builder; // Return builder for chaining
            },
            select: (cols: string = '*') => ({
              then: async (resolve: any) => {
                const result = await pool.query(`${updateQuery} RETURNING ${cols}`, params);
                resolve({ data: result.rows, error: null });
              }
            }),
            then: async (resolve: any) => {
              const result = await pool.query(`${updateQuery} RETURNING *`, params);
              resolve({ data: result.rows, error: null });
            }
          };
          
          return builder;
        },
        delete: () => {
          let deleteQuery = `DELETE FROM ${table}`;
          const params: any[] = [];
          let paramIndex = 1;
          
          const builder: any = {
            eq: (col: string, val: any) => {
              if (params.length === 0) deleteQuery += ` WHERE ${col} = $${paramIndex}`;
              else deleteQuery += ` AND ${col} = $${paramIndex}`;
              params.push(val);
              paramIndex++;
              return builder;
            },
            then: async (resolve: any) => {
              const result = await pool.query(`${deleteQuery} RETURNING *`, params);
              resolve({ data: result.rows, error: null });
            }
          };
          return builder;
        }
      };
    },
    rpc: (fn: string, params: any) => {
      return {
        then: async (resolve: any, reject: any) => {
          try {
            if (fn === 'match_note_sections' || fn === 'match_piazza_posts') {
              const result = await pool.query(`SELECT * FROM ${fn}($1, $2, $3, $4)`, [
                params.query_embedding || null,
                params.match_count || 10,
                params.course_filter || null,
                params.user_filter || null
              ]);
              resolve({ data: result.rows, error: null });
            } else {
              const result = await pool.query(`SELECT * FROM ${fn}($1)`, [params]);
              resolve({ data: result.rows, error: null });
            }
          } catch (e: any) {
            resolve({ data: null, error: e });
          }
        }
      };
    },
    _pgPool: pool
  };
} else {
  // For Supabase: use normal client
  if (!supabaseKey) {
    throw new Error('Missing Supabase key: SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY required for Supabase URLs');
  }
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

export { supabase };
