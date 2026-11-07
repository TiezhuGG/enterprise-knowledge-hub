"""Loopback-only, bounded local ONNX embedding service. Never fetches model files at runtime."""
import argparse,hashlib,json,pathlib,threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer
p=argparse.ArgumentParser();p.add_argument('--directory',required=True);p.add_argument('--port',type=int,default=8081);a=p.parse_args()
root=pathlib.Path(a.directory);manifest=json.loads((root/'manifest.json').read_text())
for name,digest in manifest['files'].items():
 if name not in ['tokenizer.json','model_quantized.onnx'] or hashlib.sha256((root/name).read_bytes()).hexdigest()!=digest:raise ValueError('model integrity mismatch')
revision=hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest()
tokenizer=Tokenizer.from_file(str(root/'tokenizer.json'));tokenizer.no_truncation();tokenizer.no_padding()
options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
cls=tokenizer.token_to_id('[CLS]');sep=tokenizer.token_to_id('[SEP]')
if cls is None or sep is None:raise ValueError('unsupported tokenizer special tokens')
session=ort.InferenceSession(str(root/'model_quantized.onnx'),sess_options=options,providers=['CPUExecutionProvider']);inputs={x.name for x in session.get_inputs()};lock=threading.Lock()
def encode(text):
 ids=tokenizer.encode(text,add_special_tokens=False).ids
 if not ids:raise ValueError('empty tokens')
 vectors=[];weights=[]
 for start in range(0,len(ids),510):
  window=ids[start:start+510];tokens=[cls]+window+[sep];feed={'input_ids':np.array([tokens],dtype=np.int64),'attention_mask':np.ones((1,len(tokens)),dtype=np.int64),'token_type_ids':np.zeros((1,len(tokens)),dtype=np.int64)}
  result=session.run(None,{k:v for k,v in feed.items() if k in inputs})[0][0,0,:].astype(np.float32)
  vectors.append(result/max(float(np.linalg.norm(result)),1e-12));weights.append(len(window))
 vector=np.average(vectors,axis=0,weights=weights).astype(np.float32);vector/=max(float(np.linalg.norm(vector)),1e-12)
 if len(vector)!=512 or not np.isfinite(vector).all():raise ValueError('invalid model output')
 return vector.tolist(),len(ids)+2*len(vectors)
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def respond(self,status,body):
  raw=json.dumps(body).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
 def do_GET(self):
  if self.path!='/metadata':self.respond(404,{'error':'not_found'});return
  self.respond(200,{'model':manifest['model'],'revision':revision,'dimension':512,'processing':manifest['processing'],'upstream_revision':manifest['upstream_revision']})
 def do_POST(self):
  if self.path!='/v1/embeddings':self.respond(404,{'error':'not_found'});return
  length=int(self.headers.get('Content-Length','0'))
  if length<1 or length>200000:self.respond(413,{'error':'input_limit'});return
  try:
   body=json.loads(self.rfile.read(length));texts=body['input']
   if body.get('model')!=manifest['model'] or self.headers.get('X-Embedding-Revision')!=revision:self.respond(409,{'error':'model_revision_mismatch'});return
   if not isinstance(texts,list) or not 1<=len(texts)<=32 or any(not isinstance(t,str) or not t.strip() or len(t)>4096 for t in texts):raise ValueError()
  except (ValueError,KeyError,TypeError):self.respond(400,{'error':'invalid_input'});return
  if not lock.acquire(blocking=False):self.send_response(429);self.send_header('Retry-After','1');self.end_headers();return
  try:
   data=[];tokens=0
   for i,text in enumerate(texts):
    vector,count=encode(text);tokens+=count;data.append({'index':i,'embedding':vector})
   self.respond(200,{'model':manifest['model'],'revision':revision,'data':data,'usage':{'prompt_tokens':tokens,'total_tokens':tokens}})
  except Exception:self.respond(500,{'error':'inference_failed'})
  finally:lock.release()
print('Local embedding service ready',flush=True);ThreadingHTTPServer(('127.0.0.1',a.port),Handler).serve_forever()
