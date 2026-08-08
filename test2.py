import urllib.request, json
req = urllib.request.Request('https://sarmaaya.pk/api/mutual-funds/filter', method='POST', headers={'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json'}, data=b'{}')
try:
    res = urllib.request.urlopen(req).read().decode('utf-8')
    print(res[:500])
except Exception as e:
    print('ERROR:', e)
