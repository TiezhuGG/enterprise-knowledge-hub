import {createRequire} from 'node:module';
const require=createRequire(new URL('../packages/resources/package.json',import.meta.url));const {embeddingProfile,DenseIndex}=require('./dist');
const profile=embeddingProfile();if(!profile)throw new Error('Configure INDEX_ENABLED and the frozen embedding profile first');
const dense=new DenseIndex(profile);try{await dense.ensure();console.log('Configured dense index warmed; no model calls performed')}finally{dense.close()}
