'use strict';

/**
 * Weather Monitoring App - Admin Alert System Controller CLI
 * Allows the admin to pause, resume, and inspect the backend automated alert system.
 *
 * Usage:
 *   node backend/alertAdmin.js pause
 *   node backend/alertAdmin.js resume
 *   node backend/alertAdmin.js status
 *   npm run alerts pause
 *   npm run alerts resume
 *   npm run alerts status
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
const db = require('./database/db');

const SETTING_KEY = 'alert_system_status';
const command = (process.argv[2] || '').trim().toLowerCase();

function printHeader() {
  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`   WeatherWatch — Alert System Admin Controller`);
  console.log(`══════════════════════════════════════════════════════════════`);
}

function printHelp() {
  printHeader();
  console.log(`
Usage:
  node backend/alertAdmin.js <command>
  npm run alerts <command>

Commands:
  pause     Disable the automated background alert detection system.
            No scheduled weather checks or alert emails will be dispatched
            until explicitly resumed.

  resume    Re-enable the automated background alert detection system.
            Weather monitoring cycles and alert emails will resume.

  status    Display current status (ACTIVE or PAUSED) and last modified time.

  help      Show this help menu.

Examples:
  npm run alerts pause
  npm run alerts resume
  npm run alerts status
══════════════════════════════════════════════════════════════\n`);
}

function getSystemStatus() {
  const row = db.prepare('SELECT value, updated_at FROM system_settings WHERE key = ?').get(SETTING_KEY);
  if (!row) {
    return { status: 'active', updatedAt: null };
  }
  return { status: row.value, updatedAt: row.updated_at };
}

switch (command) {
  case 'pause':
  case 'stop':
  case 'off':
  case 'disable': {
    db.setSetting(SETTING_KEY, 'paused');
    printHeader();
    console.log(`\n  STATUS:  ⏸️  PAUSED (DISABLED)`);
    console.log(`  TIME:    ${new Date().toLocaleString()}`);
    console.log(`\n  The automated alert detection system is now PAUSED.`);
    console.log(`  • Background scheduler cycles will NOT dispatch emails.`);
    console.log(`  • This state persists indefinitely (even across server restarts).`);
    console.log(`\n  👉 To resume at any time, run:`);
    console.log(`     npm run alerts resume  (or: node backend/alertAdmin.js resume)`);
    console.log(`══════════════════════════════════════════════════════════════\n`);
    break;
  }

  case 'resume':
  case 'unpause':
  case 'start':
  case 'on':
  case 'enable': {
    db.setSetting(SETTING_KEY, 'active');
    printHeader();
    console.log(`\n  STATUS:  ▶️  ACTIVE (ENABLED)`);
    console.log(`  TIME:    ${new Date().toLocaleString()}`);
    console.log(`\n  The automated alert detection system is now ACTIVE.`);
    console.log(`  • Background scheduler will check conditions on schedule.`);
    console.log(`  • Email alerts will be sent when meteorological risks occur.`);
    console.log(`\n  👉 To pause at any time, run:`);
    console.log(`     npm run alerts pause  (or: node backend/alertAdmin.js pause)`);
    console.log(`══════════════════════════════════════════════════════════════\n`);
    break;
  }

  case 'status':
  case 'info':
  case 'check': {
    const { status, updatedAt } = getSystemStatus();
    const isActive = status !== 'paused';
    const interval = process.env.WEATHER_CHECK_INTERVAL || '30';

    printHeader();
    console.log(`\n  Alert System State : ${isActive ? '▶️  ACTIVE (RUNNING)' : '⏸️  PAUSED (DISABLED)'}`);
    console.log(`  Last Changed At    : ${updatedAt ? new Date(updatedAt).toLocaleString() : 'Default (Never modified)'}`);
    console.log(`  Configured Interval: Every ${interval} minute(s)`);
    console.log(`  Recipient Email    : ${process.env.ALERT_RECIPIENT_EMAIL || 'None'}`);
    console.log(`\n  Quick Controls:`);
    if (isActive) {
      console.log(`  • To PAUSE : npm run alerts pause`);
    } else {
      console.log(`  • To RESUME: npm run alerts resume`);
    }
    console.log(`══════════════════════════════════════════════════════════════\n`);
    break;
  }

  case 'help':
  case '--help':
  case '-h':
  case '':
  default:
    printHelp();
    if (command && !['help', '--help', '-h'].includes(command)) {
      console.error(`Unknown command: "${command}". See options above.\n`);
      process.exit(1);
    }
    break;
}
