
import urllib.request, re, json
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed

def fetch_title(url):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        html = urllib.request.urlopen(req, timeout=10).read().decode()
        m = re.search(r'<title>(.*?)</title>', html, re.IGNORECASE)
        return url, m.group(1).split('|')[0].strip() if m else None
    except Exception:
        return url, None

req = urllib.request.Request('https://sarmaaya.pk/sitemap.xml', headers={'User-Agent': 'Mozilla/5.0'})
xml_data = urllib.request.urlopen(req).read().decode()
urls = [line.replace('<loc>','').replace('</loc>','').strip() for line in xml_data.split('\n') if '<loc>' in line and 'sarmaaya.pk/mutual-funds/' in line]
urls = [u for u in urls if len(u.split('/')[-1]) == 36]

print('Fetching', len(urls), 'funds...')

mapping = {}
with ThreadPoolExecutor(max_workers=20) as executor:
    future_to_url = {executor.submit(fetch_title, u): u for u in urls}
    for future in as_completed(future_to_url):
        url, title = future.result()
        if title:
            mapping[title] = url.split('/')[-1]

with open('mf_mapping.json', 'w') as f:
    json.dump(mapping, f, indent=2)
print('Saved mapping size:', len(mapping))

