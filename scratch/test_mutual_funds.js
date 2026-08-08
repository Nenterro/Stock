async function testMutualFundUrls() {
  const fundUrls = [
    'https://sarmaaya.pk/mutual-funds/meezan-sovereign-fund',
    'https://sarmaaya.pk/mutual-funds/meezan-islamic-fund',
    'https://sarmaaya.pk/mutual-funds/mzf',
    'https://sarmaaya.pk/mutual-funds/ubl-liquidity-plus-fund',
    'https://sarmaaya.pk/mutual-funds/mcb-cash-management-optimizer',
    'https://sarmaaya.pk/mutual-funds/details/meezan-islamic-fund'
  ];

  for (const url of fundUrls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
      console.log(`[${res.status}] ${url}`);
      if (res.ok) {
        const html = await res.text();
        const title = html.match(/<title>(.*?)<\/title>/i);
        console.log('   TITLE:', title ? title[1] : 'No title');
        
        // Search for NAV / Price in HTML
        const navMatch = html.match(/Rs\.?\s*([0-9,]+(?:\.[0-9]+)?)/i) || html.match(/NAV[:\s]*Rs\.?\s*([0-9.]+)/i);
        if (navMatch) {
          console.log('   NAV match:', navMatch[0]);
        }
      }
    } catch(e) {
      console.log(`[ERR] ${url}:`, e.message);
    }
  }
}

testMutualFundUrls();
