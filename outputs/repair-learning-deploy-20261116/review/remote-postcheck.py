# Read-only: identity, process presence, named artifact hashes, rollback tar inventory. Never read env.
import os, socket, json, hashlib, subprocess, tarfile
result={'hostname':socket.gethostname(),'privateAddresses':subprocess.check_output(['hostname','-I'],text=True).strip().split(),'instanceId':open('/var/lib/cloud/data/instance-id').read().strip()}
assert result['hostname']=='VM-4-8-ubuntu'
assert '10.0.4.8' in result['privateAddresses']
assert result['instanceId']=='ins-2s08wnpd'
root='/opt/pms-repair/apps/api'
result['apiDirectory']=os.path.realpath(root)
assert result['apiDirectory']==root
pidOutput=subprocess.check_output(['pm2','pid','pms-api'],text=True).strip()
pids=[int(s) for s in pidOutput.splitlines() if s.isdecimal() and int(s)>0]
assert len(pids)==1,pidOutput
pid=pids[0]
result['service']={'name':'pms-api','pid':pid,'cwd':os.readlink('/proc/'+str(pid)+'/cwd'),'ps':subprocess.check_output(['ps','-p',str(pid),'-o','comm=,stat='],text=True).strip()}
assert result['service']['cwd']==root
assert result['service']['ps'] and 'Z' not in result['service']['ps'].split()[-1]
def sha(file):
 h=hashlib.sha256()
 with open(file,'rb') as f:
  for data in iter(lambda:f.read(1024*1024),b''):h.update(data)
 return h.hexdigest()
files=['dist/modules/repairs/repairs.service.js','dist/modules/ai/extract-samples.service.js','dist/modules/ai/repair-text.ai.js']
result['artifacts']=[{'relativePath':p,'path':root+'/'+p,'bytes':os.path.getsize(root+'/'+p),'sha256':sha(root+'/'+p)} for p in files]
backup='/opt/pms-backups/api/pms-api-rollback-20261116-120900.tar.gz'
assert os.path.isfile(backup)
with tarfile.open(backup,'r:gz') as archive:members=sum(1 for _ in archive)
result['rollback']={'path':backup,'bytes':os.path.getsize(backup),'sha256':sha(backup),'members':members,'extracted':False}
assert result['rollback']['sha256']=='8a1332160de6165cdbdfc0a2a130e36b4fbf6a6faa68651c8afb83fd56a66d5d'
assert members==1474
print(json.dumps(result,indent=2))
