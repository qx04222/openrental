from playwright.sync_api import sync_playwright, expect
from pathlib import Path
import json, os
BASE=os.environ.get('OPENRENTAL_BASE_URL','http://localhost:3218')
OUTPUT=Path(os.environ.get('OPENRENTAL_BROWSER_OUTPUT', 'browser-evidence'))
OUTPUT.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
 b=p.chromium.launch(headless=True)
 page=b.new_page(viewport={'width':1440,'height':1000})
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(BASE+'/admin/login');page.locator('#login-username').fill(os.environ.get('ADMIN_USERNAME','admin'));page.locator('#login-password').fill(os.environ.get('ADMIN_PASSWORD','admin123'));page.get_by_role('button',name='Sign In',exact=True).click()
 expect(page.locator('#desk-title')).to_be_visible(timeout=30000)
 page.wait_for_load_state('networkidle')
 page.screenshot(path=str(OUTPUT/'workspace-desktop.png'),full_page=True)
 # Open the existing invoice from a real queue item, using its observed link.
 links=page.locator('.desk-item')
 if links.count():
  links.first.click();expect(page).to_have_url(__import__('re').compile('invoiceId='));page.wait_for_load_state('networkidle');print('PASS queue invoice deep link')
 page.goto(BASE+'/admin/rental-fleet');page.wait_for_load_state('networkidle');expect(page.get_by_label('Main navigation')).to_be_visible()
 page.screenshot(path=str(OUTPUT/'fleet-desktop.png'),full_page=True)
 # Demonstrate query failures do not show zero totals, then recover.
 page.route('**/api/trpc/**dashboard.stats**',lambda route: route.fulfill(status=503,content_type='application/json',body='[]'))
 page.goto(BASE+'/admin');expect(page.get_by_role('alert')).to_be_visible(timeout=30000)
 expect(page.locator('#desk-title')).to_have_count(0)
 page.screenshot(path=str(OUTPUT/'workspace-recovery.png'),full_page=True)
 page.unroute('**/api/trpc/**dashboard.stats**');page.get_by_role('alert').get_by_role('button',name='Try again',exact=True).click();expect(page.locator('#desk-title')).to_be_visible(timeout=30000)
 print('PASS database error UI and retry')
 for width in [390,768,1440]:
  page.set_viewport_size({'width':width,'height':900});page.reload();expect(page.locator('#desk-title')).to_be_visible();page.wait_for_load_state('networkidle')
  assert not page.evaluate('document.documentElement.scrollWidth > innerWidth'), f'overflow at {width}'
  if width==390:
   page.screenshot(path=str(OUTPUT/'workspace-mobile.png'),full_page=True)
   page.get_by_role('button',name='Open navigation').click();expect(page.locator('#workspace-navigation')).to_have_class(__import__('re').compile('translate-x-0'))
   page.keyboard.press('Escape');expect(page.get_by_role('button',name='Open navigation')).to_have_attribute('aria-expanded','false')
 print('PASS responsive widths and mobile navigation')
 # Verify explicit language preference rather than assuming browser locale.
 page.evaluate("localStorage.setItem('i18nextLng','zh')");page.reload();page.wait_for_load_state('networkidle');expect(page.locator('#desk-title')).to_contain_text('今天')
 page.screenshot(path=str(OUTPUT/'workspace-chinese.png'),full_page=True)
 assert not errors, errors
 (OUTPUT/'browser-validation.json').write_text(json.dumps({'base':BASE,'checks':['login','invoice deep link when populated','fleet route','failure/retry','390/768/1440 responsive','mobile navigation Escape','Chinese locale'],'pageErrors':errors},indent=2))
 print('PASS bilingual dashboard; no page errors');b.close()
