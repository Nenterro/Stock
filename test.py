import urllib.request, re
req = urllib.request.Request('https://sarmaaya.pk/mutual-funds', headers={'User-Agent': 'Mozilla/5.0'})
try:
    html = urllib.request.urlopen(req).read().decode('utf-8')
    funds = re.findall(r'href="/mutual-funds/details/(\d+)"[^>]*>([^<]+)<', html, re.IGNORECASE)
    print('Found mutual funds:', len(funds))
    for f in funds[:20]: print(f)
except Exception as e:
    print('ERROR:', e)
