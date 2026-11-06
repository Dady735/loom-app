import { db, createBackup } from './db.js';
if (process.argv.includes('--check')) {
  const integrity = db.pragma('integrity_check');
  const foreignKeys = db.pragma('foreign_key_check') as unknown[];
  console.log(JSON.stringify({ integrity, foreignKeys }, null, 2));
  process.exitCode = JSON.stringify(integrity) === '[{"integrity_check":"ok"}]' && foreignKeys.length === 0 ? 0 : 1;
} else {
  const backup = await createBackup('Operator-requested CLI backup');
  console.log(JSON.stringify(backup, null, 2));
  console.log('Copy this backup AND the separately protected encryption key to encrypted off-site storage. Never commit either.');
}
db.close();
