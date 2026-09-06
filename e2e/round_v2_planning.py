"""2.0 planning: real SQL fixtures and real authenticated API; scratch DB only."""
import os,sys,subprocess,uuid
from datetime import datetime,timedelta
from zoneinfo import ZoneInfo
sys.path.insert(0,os.path.dirname(__file__))
from harness import api_admin,api_field,api_anon,trpc,TrpcError,TEST_DB
assert TEST_DB.startswith('openrental_') and os.environ.get('PGHOST','localhost') in ('localhost','127.0.0.1'), 'Use a local OpenRental scratch database'
def sql(query):
 return subprocess.check_output(['psql','-d',TEST_DB,'-v','ON_ERROR_STOP=1','-Atq','-c',query],text=True).strip()
tag='V2'+uuid.uuid4().hex[:8];assets=[];rentals=[]
def asset(status='available'):
 value=int(sql(f'''INSERT INTO rental_fleet (brand,model,"assetNumber","currentStatus") VALUES ('QA','Planner','{tag}-{len(assets)}','{status}') RETURNING id'''));assets.append(value);return value
def rental(fleet,start,end,status='approved'):
 value=int(sql(f'''INSERT INTO rental_requests ("customerName","rentalFleetId","startDate","endDate",status) VALUES ('{tag}',{fleet if fleet else 'NULL'},'{start}','{end}','{status}') RETURNING id'''));rentals.append(value);return value
def timeline(start):return {r['id']:r for r in trpc(admin,'planning.timeline',{'start':start,'days':7},method='GET')['rows']}
admin=api_admin()
try:
 a,b,c,d=asset(),asset(),asset('maintenance'),asset()
 parent=rental(a,'2026-11-01 04:00:00','2026-11-10 05:00:00')
 sql(f'''INSERT INTO rental_line_items ("rentalRequestId","rentalFleetId","startDate","endDate") VALUES ({parent},{a},'2026-11-02 05:00:00','2026-11-03 05:00:00'),({parent},{b},'2026-11-03 05:00:00','2026-11-04 05:00:00')''')
 rental(a,'2026-11-03 05:00:00','2026-11-05 05:00:00')
 rental(a,'2026-11-06 05:00:00','2026-11-07 05:00:00','cancelled')
 # 02:00 UTC falls on the previous Toronto calendar day.
 rental(d,'2026-11-01 02:00:00','2026-11-01 03:00:00')
 rows=timeline('2026-11-01')
 assert rows[a]['days'][0]['state']=='available', 'parent dates must not override exact line dates'
 assert rows[a]['days'][2]['conflict'], 'distinct bookings overlap'
 assert rows[a]['days'][5]['state']=='available', 'cancelled order must not reserve'
 assert rows[b]['days'][2]['state']=='reserved', 'second line asset missing'
 assert all(x['state']=='maintenance' for x in rows[c]['days'])
 assert timeline('2026-10-31')[d]['days'][0]['state']=='reserved', 'Toronto date boundary'
 assert rows[d]['days'][0]['state']=='available', 'UTC date must not add a wrong day'
 sql(f'''INSERT INTO work_orders ("workOrderNumber","rentalFleetId") VALUES ('{tag}',{d})''')
 assert all(x['state']=='work_order' for x in timeline('2026-11-01')[d]['days'])
 rental(d,'2026-11-01 04:00:00','2026-11-02 05:00:00','active')
 assert all(x['state']=='work_order' for x in timeline('2026-11-01')[d]['days']), 'live rental must not hide an unresolved work order after its dates'
 today=datetime.now(ZoneInfo('America/Toronto')).date();old=(today-timedelta(days=2)).isoformat();rental(b,old,old,'overdue')
 assert all(x['overdue'] for x in timeline(today.isoformat())[b]['days']), 'overdue custody must extend'
 for session,proc,args,code in [(api_anon(),'planning.timeline',{'start':'2026-11-01','days':7},'UNAUTHORIZED'),(api_field(),'operations.status',None,'FORBIDDEN'),(admin,'planning.timeline',{'start':'2026-02-30','days':7},'BAD_REQUEST')]:
  try:trpc(session,proc,args,method='GET');raise AssertionError('Unexpected access')
  except TrpcError as e:assert e.code==code,(proc,e.code)
 field=api_field()
 saved=trpc(admin,'rolePermissions.listForRole',{'role':'field_staff'},method='GET')
 columns=['module','canRead','canCreate','canUpdate','canDelete']
 original=[{k:r[k] for k in columns} for r in saved]
 try:
  for fleet_read,rentals_read,allowed in [(True,False,False),(False,True,False),(True,True,True)]:
   matrix=[r for r in original if r['module'] not in ('fleet','rentals')]
   matrix += [{'module':mod,'canRead':read,'canCreate':False,'canUpdate':False,'canDelete':False} for mod,read in [('fleet',fleet_read),('rentals',rentals_read)]]
   trpc(admin,'rolePermissions.bulkUpdate',{'role':'field_staff','permissions':matrix})
   try:
    trpc(field,'planning.timeline',{'start':'2026-11-01','days':7},method='GET')
    assert allowed,'One missing module permission must deny the combined planner'
   except TrpcError as e:assert not allowed and e.code=='FORBIDDEN',e.code
 finally:trpc(admin,'rolePermissions.bulkUpdate',{'role':'field_staff','permissions':original})
 sql(f'''INSERT INTO rental_lifecycle_effects ("commandKey","rentalRequestId","effectType",status,payload,"lastError") VALUES ('{tag}',{parent},'send_email','manual_review','{{"token":"PRIVATE-QA-TOKEN"}}','PRIVATE-QA-ERROR')''')
 status=trpc(admin,'operations.status',method='GET');assert len(status['jobs'])==8
 effect=next(e for e in status['effects'] if e['rentalId']==parent)
 assert effect['status']=='manual_review' and 'payload' not in effect and 'lastError' not in effect
 assert 'PRIVATE-QA' not in str(status),'Operations must exclude private payload and raw error'
 assert next(c['count'] for c in status['counts'] if c['status']=='manual_review')>=1
 print('PASS planner line assignments, duplicate parent suppression, overlap, cancellation, maintenance, work-order holds, DST boundary, overdue custody, denied access, invalid date and 8 scheduled jobs')
finally:
 if assets:sql(f'''DELETE FROM work_orders WHERE "workOrderNumber"='{tag}'; DELETE FROM rental_lifecycle_effects WHERE "commandKey"='{tag}'; DELETE FROM rental_line_items WHERE "rentalRequestId" IN ({','.join(map(str,rentals)) or '0'}); DELETE FROM rental_requests WHERE id IN ({','.join(map(str,rentals)) or '0'}); DELETE FROM rental_fleet WHERE id IN ({','.join(map(str,assets))});''')
