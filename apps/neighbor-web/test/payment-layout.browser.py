# /// script
# requires-python = ">=3.11"
# dependencies = ["websockets"]
# ///
"""Real Chrome layout regression; use a local read-only API fixture, never real collections.
Usage: uv run test/payment-layout.browser.py http://127.0.0.1:PORT [output-directory]
"""
import asyncio
import base64
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit

import websockets

BASE = sys.argv[1].rstrip('/')
assert urlsplit(BASE).hostname in ('127.0.0.1', 'localhost'), 'Local fixture only'
OUT = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else os.environ['TMPDIR']) / 'payment-layout'
OUT.mkdir(parents=True, exist_ok=True)
MEASURE = """(()=>{const group=document.querySelector('.cashier-payment'),g=group.getBoundingClientRect();return Array.from(group.querySelectorAll('button')).map(b=>{const r=b.getBoundingClientRect(),s=b.querySelector('svg'),v=s.getBoundingClientRect(),t=b.querySelector('span').getBoundingClientRect(),a=document.querySelector('.cashier-checkout').getBoundingClientRect();return{label:b.textContent.trim(),selected:b.classList.contains('active'),columns:getComputedStyle(b).gridTemplateColumns,iconWidth:v.width,iconHeight:v.height,contained:[v,t,r].every(x=>x.left>=r.left-1&&x.right<=r.right+1&&x.top>=r.top-1&&x.bottom<=r.bottom+1)&&r.left>=g.left-1&&r.right<=g.right+1&&g.left>=a.left-1&&g.right<=a.right+1,stacked:t.top>=v.bottom-1,centered:Math.abs((t.left+t.right-v.left-v.right)/2)<2,ratioOk:Math.abs(v.width/Math.max(v.height,.001)-s.viewBox.baseVal.width/s.viewBox.baseVal.height)<.03}})})()"""

async def run(ws):
    seq = 0
    errors = []
    evidence = []
    selection_checks = 0
    async def cdp(method, params=None):
        nonlocal seq
        seq += 1
        ident = seq
        await ws.send(json.dumps({'id': ident, 'method': method, 'params': params or {}}))
        while True:
            result = json.loads(await ws.recv())
            if result.get('method') == 'Runtime.exceptionThrown':
                errors.append(result['params'])
            if result.get('id') == ident:
                assert not result.get('error'), result.get('error')
                return result.get('result', {})
    async def js(expression):
        result = await cdp('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': True})
        assert not result.get('exceptionDetails'), result.get('exceptionDetails')
        return result.get('result', {}).get('value')
    await cdp('Page.enable')
    await cdp('Runtime.enable')
    await cdp('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 1000, 'deviceScaleFactor': 1, 'mobile': False})
    await cdp('Page.navigate', {'url': BASE + '/apartment'})
    for _ in range(150):
        if await js("document.querySelectorAll('.cashier-payment button').length===3"):
            break
        await asyncio.sleep(.1)
    else:
        raise AssertionError('Payment cards did not load')
    await asyncio.sleep(.5)
    # Prove the geometry checks detect the original global .cash collision.
    await js("document.querySelector('.cashier-payment button:last-child').classList.add('cash')")
    bad = (await js(MEASURE))[-1]
    assert bad['iconWidth'] < 1 or not bad['contained'], bad
    await js("document.querySelector('.cashier-payment button:last-child').classList.remove('cash')")
    for width in (1440, 1280, 1024, 390):
        await cdp('Emulation.setDeviceMetricsOverride', {'width': width, 'height': 1000, 'deviceScaleFactor': 1, 'mobile': False})
        for theme in ('slate', 'ocean', 'jade', 'indigo', 'sand', 'rose'):
            await js('document.documentElement.dataset.uiTheme=' + json.dumps(theme))
            await asyncio.sleep(.04)
            rows = await js(MEASURE)
            assert len(rows) == 3
            for row in rows:
                assert row['iconWidth'] >= 30 and row['iconHeight'] >= 20, row
                assert row['contained'] and row['stacked'] and row['centered'] and row['ratioOk'], row
            evidence.append({'width': width, 'theme': theme, 'cards': rows})
        for index in range(3):
            p = await js("(()=>{const b=document.querySelectorAll('.cashier-payment button')[" + str(index) + "];b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()")
            for kind in ('mousePressed', 'mouseReleased'):
                await cdp('Input.dispatchMouseEvent', {'type': kind, 'button': 'left', 'clickCount': 1, **p})
            await asyncio.sleep(.1)
            selected = await js("Array.from(document.querySelectorAll('.cashier-payment button')).map(b=>b.classList.contains('active'))")
            assert selected == [i == index for i in range(3)], selected
            selection_checks += 1
        rect = await js("(()=>{const r=document.querySelector('.cashier-payment').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1}})()")
        image = await cdp('Page.captureScreenshot', {'format': 'png', 'clip': rect, 'captureBeyondViewport': True})
        (OUT / f'payment-{width}.png').write_bytes(base64.b64decode(image['data']))
    assert not errors, errors
    result = {'layoutCases': len(evidence), 'realMouseSelections': selection_checks, 'originalCollisionDetected': True, 'errors': errors, 'evidence': evidence}
    (OUT / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'layoutCases': len(evidence), 'realMouseSelections': selection_checks, 'originalCollisionDetected': True, 'errors': len(errors), 'output': str(OUT)}, ensure_ascii=False))

async def main():
    chrome_path = os.environ.get('CHROME_PATH', 'C:/Program Files/Google/Chrome/Application/chrome.exe')
    with tempfile.TemporaryDirectory(prefix='payment-browser-', dir=OUT) as profile:
        chrome = subprocess.Popen([chrome_path, '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            for _ in range(150):
                try:
                    port = (pathlib.Path(profile) / 'DevToolsActivePort').read_text().splitlines()[0]
                    tabs = json.load(urllib.request.urlopen('http://127.0.0.1:' + port + '/json/list', timeout=1))
                    target = next(t for t in tabs if t['type'] == 'page')
                    break
                except (OSError, StopIteration, ValueError):
                    await asyncio.sleep(.1)
            else:
                raise RuntimeError('Chrome CDP unavailable')
            async with websockets.connect(target['webSocketDebuggerUrl'], max_size=25_000_000) as ws:
                await run(ws)
        finally:
            chrome.terminate()
            try:
                chrome.wait(timeout=10)
            except subprocess.TimeoutExpired:
                chrome.kill()
                chrome.wait(timeout=10)
            # Chrome subprocesses may briefly retain the profile on Windows.
            await asyncio.sleep(.5)

if __name__ == '__main__':
    asyncio.run(main())
