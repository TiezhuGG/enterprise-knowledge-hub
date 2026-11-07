const { S3Objects } = require('../dist');
const store=new S3Objects(process.env.S3_BUCKET??'');
store.initializeDevelopment().then(()=>console.log('Development bucket ready; versioning enabled')).catch(()=>{console.error('Storage setup failed; check S3 configuration and development mode');process.exitCode=1}).finally(()=>store.close());
