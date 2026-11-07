const { UploadStore, S3Objects, uploadLimits } = require('../dist');
const tenant=process.argv[2];if(!tenant||!/^[0-9a-f-]{36}$/.test(tenant)){console.error('Supply the tenant UUID for explicit upload garbage collection');process.exit(1)}
const store=new UploadStore(process.env.DATABASE_URL,process.env.DATABASE_SCHEMA,process.env.RESOURCE_CURSOR_SECRET,new S3Objects(process.env.S3_BUCKET??''),uploadLimits());
store.cleanupUnusedUploads(tenant).then(count=>console.log(`Removed ${count} unused uploaded objects`)).catch(()=>{console.error('Upload cleanup failed');process.exitCode=1}).finally(()=>store.close());
