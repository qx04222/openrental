"""Bounded queue, exact totals and Toronto calendar-age proof on a scratch DB."""
import os,sys,subprocess,uuid,json
sys.path.insert(0,os.path.dirname(__file__))
from harness import api_admin,api_field,trpc,TrpcError,TEST_DB
assert TEST_DB.startswith('openrental_') and os.environ.get('PGHOST','localhost') in ('localhost','127.0.0.1')
def sql(query):return subprocess.check_output(['psql','-d',TEST_DB,'-Atq','-v','ON_ERROR_STOP=1','-c',query],text=True).strip()
tag='INTEL-'+uuid.uuid4().hex[:8];admin=api_admin()
try:
 before=trpc(admin,'reports.internalWorkQueue',method='GET');old=next((b for b in before['buckets'] if b['kind']=='work_order'),{'count':0,'overdueCount':0})
 sql(f'''INSERT INTO work_orders ("workOrderNumber","createdAt") SELECT '{tag}-' || n, TIMESTAMP '2000-01-01' + n * INTERVAL '1 day' FROM generate_series(0,79) n''')
 queue=trpc(admin,'reports.internalWorkQueue',method='GET');bucket=next(b for b in queue['buckets'] if b['kind']=='work_order')
 assert bucket['count']==old['count']+80 and bucket['overdueCount']==old['overdueCount']+80
 assert len(bucket['items'])==25 and bucket['truncated']
 assert bucket['items'][0]['ref']==tag+'-0' and bucket['items'][-1]['ref']==tag+'-24'
 sql(f'''DELETE FROM work_orders WHERE "workOrderNumber" LIKE '{tag}-%' ''')
 item=int(sql(f'''INSERT INTO work_orders ("workOrderNumber","createdAt") VALUES ('{tag}','2026-11-01 02:00:00') RETURNING id'''))
 env={**os.environ,'DATABASE_URL':os.environ.get('DATABASE_URL_TEST',f'postgresql://{os.environ.get("USER","postgres")}@localhost:5432/{TEST_DB}'),'APP_TIMEZONE':'America/Toronto'}
 code=f'''import {{getDb,closePool}} from './server/db/core.ts';import {{getInternalWorkQueue}} from './server/services/internalWorkQueue.ts';const db=await getDb();for(const [time,expected] of [['2026-11-01T03:00:00Z',0],['2026-11-01T06:00:00Z',1]]){{let rows=0;const q=await getInternalWorkQueue({{execute:async query=>{{const r=await db.execute(query);rows=r.length;return r}}}},new Date(time));if(rows>200)throw new Error('Unbounded DB results');const item=q.buckets.find(b=>b.kind==='work_order').items.find(i=>i.id==={item});if(item?.ageDays!==expected)throw new Error('Wrong Toronto calendar age');}}await closePool();'''
 subprocess.run(['node','--import','tsx','--input-type=module','-e',code],env=env,check=True,stdout=subprocess.DEVNULL,timeout=30)
 field=api_field()
 try:trpc(field,'reports.internalWorkQueue',method='GET');raise AssertionError('Reports permission bypass')
 except TrpcError as e:assert e.code=='FORBIDDEN'
 print('PASS exact totals with 80-row queue; 25 oldest items; bounded database results; Toronto DST age; unauthorized role denied')
finally:sql(f'''DELETE FROM work_orders WHERE "workOrderNumber" LIKE '{tag}%' ''')
