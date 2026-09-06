"""Two OS processes contend for one PostgreSQL scheduled-job lock."""
from pathlib import Path
import os,subprocess,sys,uuid,time,selectors
sys.path.insert(0,os.path.dirname(__file__))
from harness import TEST_DB
assert TEST_DB.startswith('openrental_') and os.environ.get('PGHOST','localhost') in ('localhost','127.0.0.1'), 'Scratch DB required'
root=Path(__file__).resolve().parents[1];key='qa-'+uuid.uuid4().hex
url=os.environ.get('DATABASE_URL_TEST',f'postgresql://{os.environ.get("USER","postgres")}@localhost:5432/{TEST_DB}')
env={**os.environ,'DATABASE_URL':url,'NODE_ENV':'test'}
imports='import {withDatabaseJobLock,closePool} from "./server/db/core.ts";'
first_code=imports+f'await withDatabaseJobLock("{key}",async()=>{{console.log("LOCK_HELD");await new Promise(r=>setTimeout(r,4000));}});await closePool();'
second_code=imports+f'const got=await withDatabaseJobLock("{key}",async()=>{{throw new Error("Second runner entered");}});if(got)throw new Error("Lock failed");console.log("SECOND_SKIPPED");await closePool();'
first=subprocess.Popen(['node','--import','tsx','--input-type=module','-e',first_code],cwd=root,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
try:
 sel=selectors.DefaultSelector();sel.register(first.stdout,selectors.EVENT_READ);ready=False;deadline=time.monotonic()+20
 while time.monotonic()<deadline:
  if sel.select(timeout=1):
   line=first.stdout.readline()
   if 'LOCK_HELD' in line:ready=True;break
   if not line:break
 assert ready,'First lock was not acquired'
 second=subprocess.run(['node','--import','tsx','--input-type=module','-e',second_code],cwd=root,env=env,capture_output=True,text=True,timeout=20)
 assert second.returncode==0 and 'SECOND_SKIPPED' in second.stdout, second.stderr
 first.wait(timeout=20);assert first.returncode==0
 # The connection must release a held lock even if the work fails.
 recovery=imports+f'try{{await withDatabaseJobLock("{key}",async()=>{{throw new Error("expected");}})}}catch{{}};const ok=await withDatabaseJobLock("{key}",async()=>{{}});if(!ok)throw new Error("Leaked lock");await closePool();'
 subprocess.run(['node','--import','tsx','--input-type=module','-e',recovery],cwd=root,env=env,check=True,timeout=20,stdout=subprocess.DEVNULL)
 # Fail closed when no database is configured: work must never execute.
 outage=imports+'import {trackScheduledJob,runScheduledJob,getScheduledJobStates} from "./server/services/scheduledJobs.ts";trackScheduledJob("outage","* * * * *","UTC");let ran=false;await runScheduledJob("outage",async()=>{ran=true});if(ran||getScheduledJobStates()[0].status!=="failed")throw new Error("False success without database");await closePool();'
 subprocess.run(['node','--import','tsx','--input-type=module','-e',outage],cwd=root,env={**env,'DATABASE_URL':''},check=True,timeout=20,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 print('PASS two independent processes: second skipped; lock released after success and exception; missing database fails closed')
finally:
 if first.poll() is None:first.terminate();first.wait(timeout=10)
