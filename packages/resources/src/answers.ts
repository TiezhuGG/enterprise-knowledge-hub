import {randomUUID} from 'node:crypto';
import type {AnswerResponse,IdentityContext,SearchInput} from '@zhiheng/contracts';
import {RetrievalStore} from './retrieval';import {GenerationFailure,generationProfile,generate} from './generation';import {fail,ResourceError} from './policy';
export class AnswerStore extends RetrievalStore {
 private readonly answering=new Set<string>();
 async answer(current:IdentityContext,input:SearchInput,signal=AbortSignal.timeout(95000)):Promise<AnswerResponse>{
  const key=`${current.tenant_id}:${current.membership_id}`;
  if(this.answering.has(key)||this.answering.size>=2)fail(429,'ANSWER_BUSY');this.answering.add(key);
  const base:AnswerResponse={answer_id:randomUUID(),status:'refused',message:'当前证据不足，无法可靠回答。请补充资料或明确问题。',reason:'insufficient_evidence',claims:[],sources:[],model:null,usage:{prompt_tokens:null,completion_tokens:null}};
  try{
   const evidence=await this.search(current,input,signal);if(!evidence.data.length)return base;
   let profile;try{profile=generationProfile()}catch{return {...base,status:'failed',reason:'generation_unavailable',message:'本地生成服务尚未配置完成。'}}
   if(!profile)return {...base,status:'failed',reason:'generation_unavailable',message:'本地生成服务尚未配置完成。'};
   base.model={name:profile.model,revision:profile.revision,prompt_version:'extractive-v1'};
   // Dispatch under all source gates, then release locks while inference runs.
   // Wrap the promise so the transaction does not hold ACL locks during inference.
   const dispatch=await this.withEvidence(current,evidence.data,fresh=>{if(signal.aborted)fail(408,'ANSWER_CANCELLED');const pending=generate(profile,input.query,fresh,signal);void pending.catch(()=>{});return {pending}});
   const generated=await dispatch.pending;
   return await this.withEvidence(current,evidence.data,fresh=>{
    if(signal.aborted)fail(408,'ANSWER_CANCELLED');
    if(generated.status==='insufficient')return {...base,usage:generated.usage};
    const conflict=generated.status==='conflict';return {...base,status:conflict?'conflict':'answered',reason:conflict?'conflicting_evidence':'verified_quotes',message:conflict?'资料可能存在不一致，请核对以下原文，暂不作确定结论。':'以下为与问题相关、已逐字核验的原文摘录。',claims:generated.claims,sources:fresh.filter(e=>generated.claims.some(c=>c.evidence_id===e.evidence_id)),usage:generated.usage};
   });
  }catch(error){
   if(error instanceof GenerationFailure)return {...base,status:'failed',reason:error.code,message:error.code==='invalid_model_output'?'模型输出未通过原文与引用校验，已停止展示。':error.code==='generation_timeout'?'本地生成服务超时，本次未产生可核验回答。':'本地生成服务未完成请求，本次未产生可核验回答。'};
   if(error instanceof ResourceError&&error.status===404)return {...base,reason:'sources_changed',message:'资料范围、发布版本或权限已变化，请刷新后重试。'};
   throw error;
  }finally{this.answering.delete(key)}
 }
}
