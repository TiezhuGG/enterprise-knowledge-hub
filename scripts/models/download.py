"""Fetch one pinned model snapshot; run only after allowing Hugging Face in environment settings."""
import argparse, hashlib, json, pathlib, urllib.request
p=argparse.ArgumentParser();p.add_argument('--directory',required=True);p.add_argument('--revision',required=True,help='Hugging Face commit SHA, never main');a=p.parse_args()
if len(a.revision)!=40 or any(c not in '0123456789abcdef' for c in a.revision):p.error('revision must be a 40-character commit SHA')
root=pathlib.Path(a.directory);root.mkdir(parents=True,exist_ok=True)
files={}
for name in ['tokenizer.json','onnx/model_quantized.onnx']:
 target=root/pathlib.Path(name).name
 with urllib.request.urlopen(f'https://huggingface.co/Xenova/bge-small-zh-v1.5/resolve/{a.revision}/{name}',timeout=120) as response, target.open('wb') as out:
  size=0
  while chunk:=response.read(1048576):
   size+=len(chunk)
   if size>100*1048576:raise ValueError('model file exceeds size limit')
   out.write(chunk)
 files[target.name]=hashlib.sha256(target.read_bytes()).hexdigest()
manifest={'model':'bge-small-zh-v1.5','upstream_revision':a.revision,'dimension':512,'files':files,'processing':'cls-token-windows-mean-l2-v1'}
(root/'manifest.json').write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n')
print('Model revision:',hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest())
