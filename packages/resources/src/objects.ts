import { S3Client, CreateBucketCommand, PutBucketVersioningCommand, GetBucketVersioningCommand, PutPublicAccessBlockCommand, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { ResourceError, fail } from './policy';
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface ObjectStore {
  readonly storageIdentity?:string;
  inventory?(prefix:string):Promise<Array<{key:string;version:string}>>;
  put(key:string,bytes:Buffer,mime:string):Promise<string>;
  read(key:string,version:string,maxBytes:number,signal?:AbortSignal):Promise<Buffer>;
  remove(key:string,version:string):Promise<void>;
  findVersion(key:string):Promise<string|null>;
}
export class S3Objects implements ObjectStore {
  private client:S3Client;
  readonly storageIdentity:string;
  constructor(private readonly bucket:string,env:NodeJS.ProcessEnv=process.env) {
    this.storageIdentity=sha256(Buffer.from(JSON.stringify([env.S3_ENDPOINT?.replace(/\/+$/,'')??'aws',env.S3_REGION??'us-east-1',bucket])));
    this.client=new S3Client({region:env.S3_REGION??'us-east-1',endpoint:env.S3_ENDPOINT||undefined,
      forcePathStyle:!!env.S3_ENDPOINT, maxAttempts:2,
      requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',
      ...(env.S3_ACCESS_KEY_ID&&env.S3_SECRET_ACCESS_KEY?{credentials:{accessKeyId:env.S3_ACCESS_KEY_ID,secretAccessKey:env.S3_SECRET_ACCESS_KEY}}:{}),
    });
  }
  private async send<T>(operation:()=>Promise<T>):Promise<T> {
    if(!this.bucket) fail(503,'OBJECT_STORE_NOT_CONFIGURED');
    try{return await operation()}catch(error){if(error instanceof ResourceError)throw error;return fail(503,'OBJECT_STORE_UNAVAILABLE')}
  }
  async initializeDevelopment() {
    if(!['development','test'].includes(process.env.NODE_ENV??'')) throw new Error('Development bucket initializer is disabled');
    await this.send(async()=>{
      try{await this.client.send(new CreateBucketCommand({Bucket:this.bucket}),{abortSignal:AbortSignal.timeout(10000)})}
      catch(error){if(!['BucketAlreadyOwnedByYou','BucketAlreadyExists'].includes((error as Error).name))throw error}
      await this.client.send(new PutPublicAccessBlockCommand({Bucket:this.bucket,PublicAccessBlockConfiguration:{BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true}}),{abortSignal:AbortSignal.timeout(10000)});
      await this.client.send(new PutBucketVersioningCommand({Bucket:this.bucket,VersioningConfiguration:{Status:'Enabled'}}),{abortSignal:AbortSignal.timeout(10000)});
    });
  }
  put(key:string,bytes:Buffer,mime:string) {return this.send(async()=>{
    const settings=await this.client.send(new GetBucketVersioningCommand({Bucket:this.bucket}),{abortSignal:AbortSignal.timeout(10000)});
    if(settings.Status!=='Enabled')fail(503,'BUCKET_VERSIONING_REQUIRED');
    try{
      const result=await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:key,Body:bytes,ContentType:mime,ContentLength:bytes.length,IfNoneMatch:'*',ChecksumSHA256:Buffer.from(sha256(bytes),'hex').toString('base64')}),{abortSignal:AbortSignal.timeout(20000)});
      if(!result.VersionId||result.VersionId==='null')fail(503,'BUCKET_VERSIONING_REQUIRED');return result.VersionId;
    }catch(error){
      if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==412)throw error;
      const head=await this.client.send(new HeadObjectCommand({Bucket:this.bucket,Key:key}),{abortSignal:AbortSignal.timeout(10000)});
      if(!head.VersionId||head.VersionId==='null')fail(503,'BUCKET_VERSIONING_REQUIRED');
      const existing=await this.read(key,head.VersionId,bytes.length);
      if(sha256(existing)!==sha256(bytes))fail(422,'STORED_CONTENT_MISMATCH');return head.VersionId;
    }
  });}
  read(key:string,version:string,maxBytes:number,signal?:AbortSignal) {return this.send(async()=>{
    const response=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:key,VersionId:version}),{abortSignal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
    if(!response.Body)fail(503,'OBJECT_MISSING');
    const chunks:Buffer[]=[];let size=0;
    for await(const chunk of response.Body as AsyncIterable<Uint8Array>){size+=chunk.length;if(size>maxBytes){(response.Body as {destroy?:()=>void}).destroy?.();fail(422,'STORED_SIZE_MISMATCH')}chunks.push(Buffer.from(chunk))}
    return Buffer.concat(chunks);
  });}
  findVersion(key:string){return this.send(async()=>{try{const result=await this.client.send(new HeadObjectCommand({Bucket:this.bucket,Key:key}),{abortSignal:AbortSignal.timeout(10000)});return result.VersionId??null}catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===404)return null;throw error}})}
  async remove(key:string,version:string){await this.send(()=>this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key:key,VersionId:version}),{abortSignal:AbortSignal.timeout(10000)}))}
  async inventory(prefix:string){return this.send(async()=>{const rows:Array<{key:string;version:string}>=[];let key:string|undefined,version:string|undefined;
    do{const page=await this.client.send(new ListObjectVersionsCommand({Bucket:this.bucket,Prefix:prefix,KeyMarker:key,VersionIdMarker:version,MaxKeys:1000}),{abortSignal:AbortSignal.timeout(10000)});
      for(const item of [...(page.Versions??[]),...(page.DeleteMarkers??[])]){if(!item.Key||!item.VersionId)fail(503,'OBJECT_INVENTORY_INCOMPLETE');rows.push({key:item.Key,version:item.VersionId})}
      if(rows.length>10000)fail(409,'OBJECT_INVENTORY_LIMIT');if(!page.IsTruncated)break;if(!page.NextKeyMarker)fail(503,'OBJECT_INVENTORY_INCOMPLETE');key=page.NextKeyMarker;version=page.NextVersionIdMarker;
    }while(true);return rows;
  })}
  close(){this.client.destroy()}
}
