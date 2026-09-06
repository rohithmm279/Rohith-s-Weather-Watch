'use strict';

/**
 * Weather Monitoring App - Database CLI Admin Utility
 * Allows querying, inspecting, and managing the SQLite database directly from the terminal.
 *
 * Usage:
 *   node backend/dbAdmin.js "SELECT * FROM users"
 *   node backend/dbAdmin.js "SELECT * FROM alert_history"
 *   node backend/dbAdmin.js tables
 *   node backend/dbAdmin.js schema users
 */

const db = require('./database/db');

// Combine remaining arguments in case the user passed unquoted queries
const args = process.argv.slice(2);
let sqlQuery = args.join(' ').trim();

if (!sqlQuery || sqlQuery === '--help' || sqlQuery === '-h') {
  console.log(`
Weather DB Admin CLI Utility
----------------------------
Usage:
  node backend/dbAdmin.js "<SQL_QUERY>"
  node backend/dbAdmin.js tables
  node backend/dbAdmin.js schema <table_name>
  node backend/dbAdmin.js reset

Examples:
  node backend/dbAdmin.js "SELECT * FROM users"
  node backend/dbAdmin.js "SELECT id, name, email, city FROM users"
  node backend/dbAdmin.js "SELECT * FROM alert_history ORDER BY alerted_at DESC LIMIT 10"
  node backend/dbAdmin.js "DELETE FROM users WHERE id = 1"
  node backend/dbAdmin.js tables
  node backend/dbAdmin.js schema users
  node backend/dbAdmin.js reset
`);
  process.exit(0);
}

// Built-in convenience shortcuts
if (sqlQuery.toLowerCase() === 'tables') {
  sqlQuery = "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'";
} else if (sqlQuery.toLowerCase() === 'reset' || sqlQuery.toLowerCase() === 'clear-all') {
  try {
    db.exec(`
      DELETE FROM alert_history;
      DELETE FROM users;
      DELETE FROM sqlite_sequence WHERE name IN ('users', 'alert_history');
    `);
    console.log('\nDatabase reset successfully:');
    console.log('- Cleared all records from `alert_history`');
    console.log('- Cleared all records from `users`');
    console.log('- Reset auto-increment ID counters');
    process.exit(0);
  } catch (err) {
    console.error('\nReset Error:', err.message);
    process.exit(1);
  }
} else if (sqlQuery.toLowerCase().startsWith('schema ')) {
  const table = sqlQuery.split(/\s+/)[1];
  if (!table || !/^[a-zA-Z0-9_]+$/.test(table)) {
    console.error('Error: Invalid table name specified for schema inspection.');
    process.exit(1);
  }
  sqlQuery = `PRAGMA table_info(${table})`;
}

try {
  const normalized = sqlQuery.trim().toLowerCase();
  const isSelect = normalized.startsWith('select') || normalized.startsWith('pragma') || normalized.startsWith('explain');

  if (isSelect) {
    const stmt = db.prepare(sqlQuery);
    const rows = stmt.all();

    if (!rows || rows.length === 0) {
      console.log('Query executed successfully. 0 rows returned.');
    } else {
      console.log(`\nQuery Results (${rows.length} row${rows.length === 1 ? '' : 's'}):`);
      console.table(rows);
    }
  } else {
    // Non-select queries (INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, etc.)
    if (/^[a-zA-Z0-9_\s,;*()='"-]+$/.test(sqlQuery) && !sqlQuery.includes(';')) {
      const stmt = db.prepare(sqlQuery);
      const result = stmt.run();
      console.log('\nQuery executed successfully:');
      console.log(result);
    } else {
      db.exec(sqlQuery);
      console.log('\nStatement(s) executed successfully.');
    }
  }
} catch (err) {
  console.error('\nSQL Error:', err.message);
  process.exit(1);
}
