const { migrate } = require('../dist');
migrate(process.env.DATABASE_URL, process.env.DATABASE_SCHEMA).then(() => console.log('Resource migrations applied')).catch(() => { console.error('Migration failed; check database configuration and migration checksums'); process.exitCode=1; });
