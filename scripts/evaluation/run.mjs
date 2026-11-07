import {mkdir,readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';import {createRequire} from 'node:module';
import {safetyFailure} from './score.mjs';
import {loadDataset,sha256} from './dataset.mjs';import {modelFixtures} from './fixture.mjs';import {evaluationRuntime} from './runtime.mjs';import {codeStamp,buildReport,saveReport} from './report.mjs';
const require=createRequire(new URL('../../packages/resources/package.json',import.meta.url)),{embeddingProfile,generationProfile}=require('./dist');
function args(values){const result={mode:'real',probes:false,output:null};for(let i=0;i<values.length;i++){const v=values[i];if(v==='--fixture')result.mode='fixture';else if(v==='--real')result.mode='real';else if(v==='--probes')result.probes=true;else if(v==='--output'&&values[i+1])result.output=values[++i];else throw new Error('INVALID_EVALUATION_ARGUMENTS')}if(result.probes&&result.mode!=='fixture')throw new Error('CONTROLLED_PROBES_REQUIRE_FIXTURE_MODE');return result}
export function prices(env){const number=name=>{if(env[name]===undefined||env[name]==='')return null;const n=Number(env[name]);if(!Number.isFinite(n)||n<0)throw new Error('INVALID_EVALUATION_PRICE');return n};const currency=env.EVAL_CURRENCY??null;if(currency!==null&&!/^[A-Z]{3}$/.test(currency))throw new Error('INVALID_EVALUATION_CURRENCY');return {input_per_million:number('EVAL_GENERATION_INPUT_PER_MILLION'),output_per_million:number('EVAL_GENERATION_OUTPUT_PER_MILLION'),currency}}
const safeEmbedding=p=>p?{model:p.model,revision:p.revision,dimension:p.dimension,processing:p.processing,query_prefix:p.query_prefix,document_prefix:p.document_prefix,profile_hash:p.hash,endpoint_sha256:sha256(p.endpoint)}:null;
const safeGeneration=p=>p?{model:p.model,revision:p.revision,timeout_ms:p.timeoutMs,endpoint_sha256:sha256(p.endpoint),prompt_version:'extractive-v1',temperature:0,max_tokens:2048}:null;
export async function runBaseline(options,env=process.env){
 const frozen=await loadDataset(),runId=`${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`,output=pathToFileURL(resolve(options.output??`work/evaluations/${runId}`)+'/');await mkdir(new URL('../',output),{recursive:true,mode:0o700});await mkdir(output,{mode:0o700});
 const manifest={schema:'baseline-manifest-v1',run_id:runId,created_at:new Date().toISOString(),mode:options.mode,status:'running',dataset_version:frozen.data.version,dataset_sha256:frozen.sha256,code:await codeStamp(),parameters:frozen.data.parameters,embedding:null,generation:null,pricing:prices(env),preparation:null,blocker:null};
 let fixtures,runtime,observations=[],exitCode=0;
 try{
  let config={...env};if(options.mode==='fixture'){fixtures=await modelFixtures();config={...config,...fixtures.config}}
  let e,g;try{e=embeddingProfile({...config,MILVUS_ADDRESS:'127.0.0.1:19530'});g=generationProfile(config)}catch{manifest.blocker='INVALID_LOCAL_MODEL_CONFIGURATION'}
  if(!manifest.blocker&&(!e||!g))manifest.blocker='LOCAL_MODELS_NOT_CONFIGURED';
  if(e&&!['127.0.0.1','localhost','[::1]'].includes(new URL(e.endpoint).hostname))manifest.blocker='LOCAL_EMBEDDING_REQUIRED';
  manifest.embedding=safeEmbedding(e);manifest.generation=safeGeneration(g);
  if(manifest.blocker){manifest.status='blocked';exitCode=2}
  else{
   runtime=await evaluationRuntime(frozen.data,config,output);manifest.embedding=safeEmbedding(runtime.profile);manifest.preparation=runtime.preparation;
   for(const q of frozen.data.cases)observations.push(await runtime.run(q,frozen.data.parameters,manifest.pricing,fixtures));
   if(options.probes)for(const probe of frozen.data.probes){const q={...frozen.data.cases.find(q=>q.id===probe.case_id),id:probe.id},parameters={...frozen.data.parameters};if(probe.variable==='fixture_behavior')fixtures.behavior=probe.value;else parameters[probe.variable]=probe.value;try{observations.push(await runtime.run(q,parameters,manifest.pricing,fixtures))}finally{fixtures.behavior='normal'}}
   manifest.status=options.mode==='real'?'automatic-run-complete-human-review-pending':'protocol-run-complete-not-quality-acceptance';
  }
 }catch(error){manifest.status='failed';if(error.evaluation_namespace)manifest.cleanup_namespace=error.evaluation_namespace;manifest.blocker=['LOCAL_EVALUATION_INFRASTRUCTURE_REQUIRED','CORPUS_INDEXING_FAILED','CORPUS_INDEXING_TIMEOUT','EVALUATION_PROCESS_START_FAILED','EVALUATION_PROCESS_TIMEOUT'].includes(error.message)?error.message:'EVALUATION_RUNTIME_FAILED';exitCode=1}
 finally{try{await runtime?.close()}catch{manifest.status='failed';manifest.blocker='EVALUATION_CLEANUP_FAILED';exitCode=1}await fixtures?.close()}
 let report=buildReport(manifest,frozen.data,observations);if(safetyFailure(report.cases)){manifest.status='safety-gate-failed';exitCode=1;report=buildReport(manifest,frozen.data,observations)}await saveReport(output,report,frozen.raw);return {report,output:resolve(options.output??`work/evaluations/${runId}`),exitCode};
}
if(import.meta.url===pathToFileURL(process.argv[1]).href){try{const result=await runBaseline(args(process.argv.slice(2)));console.log(JSON.stringify({run_id:result.report.manifest.run_id,status:result.report.manifest.status,output:result.output,executed:result.report.summary.executed,total:result.report.summary.questions,quality_acceptance:result.report.acceptance}));process.exitCode=result.exitCode}catch{console.error('Evaluation failed; check arguments, frozen dataset and an unused output directory.');process.exitCode=1}}
