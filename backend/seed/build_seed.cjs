// Regenerates seed/international.json.
// Run with: node seed/build_seed.cjs
const fs = require('fs');
const path = require('path');

const out = [];
const S = (symbol, name, exchange, type, currency) => ({ symbol, name, exchange, type, currency });
const eq = (rows) => rows.forEach(([s, n, e]) => out.push(S(s, n, e || 'NASDAQ', 'Stock', 'USD')));
const etf = (rows) => rows.forEach(([s, n, e]) => out.push(S(s, n, e || 'NYSEArca', 'ETF', 'USD')));

eq([
  ['AAPL', 'Apple Inc.'], ['MSFT', 'Microsoft Corporation'], ['GOOGL', 'Alphabet Inc. Class A'],
  ['GOOG', 'Alphabet Inc. Class C'], ['AMZN', 'Amazon.com Inc.'], ['NVDA', 'NVIDIA Corporation'],
  ['META', 'Meta Platforms Inc.'], ['TSLA', 'Tesla Inc.'], ['AVGO', 'Broadcom Inc.'],
  ['BRK-B', 'Berkshire Hathaway Inc. Class B', 'NYSE'], ['LLY', 'Eli Lilly and Company', 'NYSE'],
  ['JPM', 'JPMorgan Chase & Co.', 'NYSE'], ['V', 'Visa Inc.', 'NYSE'], ['MA', 'Mastercard Incorporated', 'NYSE'],
  ['UNH', 'UnitedHealth Group Incorporated', 'NYSE'], ['XOM', 'Exxon Mobil Corporation', 'NYSE'],
  ['JNJ', 'Johnson & Johnson', 'NYSE'], ['WMT', 'Walmart Inc.', 'NYSE'],
  ['PG', 'Procter & Gamble Company', 'NYSE'], ['HD', 'Home Depot Inc.', 'NYSE'],
  ['COST', 'Costco Wholesale Corporation'], ['ORCL', 'Oracle Corporation', 'NYSE'],
  ['MRK', 'Merck & Co. Inc.', 'NYSE'], ['ABBV', 'AbbVie Inc.', 'NYSE'], ['CVX', 'Chevron Corporation', 'NYSE'],
  ['CRM', 'Salesforce Inc.', 'NYSE'], ['AMD', 'Advanced Micro Devices Inc.'], ['PEP', 'PepsiCo Inc.'],
  ['KO', 'Coca-Cola Company', 'NYSE'], ['ADBE', 'Adobe Inc.'], ['NFLX', 'Netflix Inc.'],
  ['TMO', 'Thermo Fisher Scientific Inc.', 'NYSE'], ['MCD', "McDonald's Corporation", 'NYSE'],
  ['CSCO', 'Cisco Systems Inc.'], ['ACN', 'Accenture plc', 'NYSE'], ['LIN', 'Linde plc'],
  ['ABT', 'Abbott Laboratories', 'NYSE'], ['DHR', 'Danaher Corporation', 'NYSE'], ['INTC', 'Intel Corporation'],
  ['VZ', 'Verizon Communications Inc.', 'NYSE'], ['TXN', 'Texas Instruments Incorporated'],
  ['QCOM', 'QUALCOMM Incorporated'], ['NKE', 'NIKE Inc.', 'NYSE'], ['PM', 'Philip Morris International Inc.', 'NYSE'],
  ['WFC', 'Wells Fargo & Company', 'NYSE'], ['BAC', 'Bank of America Corporation', 'NYSE'],
  ['DIS', 'Walt Disney Company', 'NYSE'], ['INTU', 'Intuit Inc.'], ['AMGN', 'Amgen Inc.'],
  ['IBM', 'International Business Machines Corporation', 'NYSE'], ['GE', 'GE Aerospace', 'NYSE'],
  ['CAT', 'Caterpillar Inc.', 'NYSE'], ['GS', 'Goldman Sachs Group Inc.', 'NYSE'], ['MS', 'Morgan Stanley', 'NYSE'],
  ['BA', 'Boeing Company', 'NYSE'], ['SBUX', 'Starbucks Corporation'], ['AMAT', 'Applied Materials Inc.'],
  ['MU', 'Micron Technology Inc.'], ['LRCX', 'Lam Research Corporation'], ['KLAC', 'KLA Corporation'],
  ['ADI', 'Analog Devices Inc.'], ['NOW', 'ServiceNow Inc.', 'NYSE'], ['UBER', 'Uber Technologies Inc.', 'NYSE'],
  ['PYPL', 'PayPal Holdings Inc.'], ['SHOP', 'Shopify Inc.', 'NYSE'], ['XYZ', 'Block Inc.', 'NYSE'],
  ['COIN', 'Coinbase Global Inc.'], ['PLTR', 'Palantir Technologies Inc.'], ['SNOW', 'Snowflake Inc.', 'NYSE'],
  ['ARM', 'Arm Holdings plc'], ['SMCI', 'Super Micro Computer Inc.'], ['MRNA', 'Moderna Inc.'],
  ['PFE', 'Pfizer Inc.', 'NYSE'], ['T', 'AT&T Inc.', 'NYSE'], ['F', 'Ford Motor Company', 'NYSE'],
  ['GM', 'General Motors Company', 'NYSE'], ['RIVN', 'Rivian Automotive Inc.'], ['LCID', 'Lucid Group Inc.'],
  ['DELL', 'Dell Technologies Inc.', 'NYSE'], ['HPQ', 'HP Inc.', 'NYSE'], ['MDT', 'Medtronic plc', 'NYSE'],
  ['SPGI', 'S&P Global Inc.', 'NYSE'], ['BLK', 'BlackRock Inc.', 'NYSE'],
  ['SCHW', 'Charles Schwab Corporation', 'NYSE'], ['AXP', 'American Express Company', 'NYSE'],
  ['C', 'Citigroup Inc.', 'NYSE'], ['MMM', '3M Company', 'NYSE'], ['HON', 'Honeywell International Inc.'],
  ['UPS', 'United Parcel Service Inc.', 'NYSE'], ['LMT', 'Lockheed Martin Corporation', 'NYSE'],
  ['RTX', 'RTX Corporation', 'NYSE'], ['DE', 'Deere & Company', 'NYSE'], ['TGT', 'Target Corporation', 'NYSE'],
  ['LOW', "Lowe's Companies Inc.", 'NYSE'], ['CVS', 'CVS Health Corporation', 'NYSE'],
  ['ELV', 'Elevance Health Inc.', 'NYSE'], ['CI', 'Cigna Group', 'NYSE'],
  ['BMY', 'Bristol-Myers Squibb Company', 'NYSE'], ['GILD', 'Gilead Sciences Inc.'],
  ['REGN', 'Regeneron Pharmaceuticals Inc.'], ['VRTX', 'Vertex Pharmaceuticals Incorporated'],
  ['ISRG', 'Intuitive Surgical Inc.'], ['BKNG', 'Booking Holdings Inc.'], ['ABNB', 'Airbnb Inc.'],
  ['MAR', 'Marriott International Inc.'], ['DAL', 'Delta Air Lines Inc.', 'NYSE'],
  ['SO', 'Southern Company', 'NYSE'], ['DUK', 'Duke Energy Corporation', 'NYSE'],
  ['NEE', 'NextEra Energy Inc.', 'NYSE'], ['COP', 'ConocoPhillips', 'NYSE'],
  ['SLB', 'Schlumberger N.V.', 'NYSE'], ['OXY', 'Occidental Petroleum Corporation', 'NYSE'],
  ['PSX', 'Phillips 66', 'NYSE'], ['MPC', 'Marathon Petroleum Corporation', 'NYSE'],
  ['VLO', 'Valero Energy Corporation', 'NYSE'], ['FCX', 'Freeport-McMoRan Inc.', 'NYSE'],
  ['NEM', 'Newmont Corporation', 'NYSE'], ['NUE', 'Nucor Corporation', 'NYSE'], ['DOW', 'Dow Inc.', 'NYSE'],
  ['SHW', 'Sherwin-Williams Company', 'NYSE'], ['ECL', 'Ecolab Inc.', 'NYSE'],
  ['APD', 'Air Products and Chemicals Inc.', 'NYSE'], ['PLD', 'Prologis Inc.', 'NYSE'],
  ['AMT', 'American Tower Corporation', 'NYSE'], ['O', 'Realty Income Corporation', 'NYSE'],
  ['SPG', 'Simon Property Group Inc.', 'NYSE'], ['CCI', 'Crown Castle Inc.', 'NYSE'],
  ['MDLZ', 'Mondelez International Inc.'], ['CL', 'Colgate-Palmolive Company', 'NYSE'],
  ['KMB', 'Kimberly-Clark Corporation', 'NYSE'], ['GIS', 'General Mills Inc.', 'NYSE'],
  ['K', 'Kellanova', 'NYSE'], ['HSY', 'Hershey Company', 'NYSE'],
  ['STZ', 'Constellation Brands Inc.', 'NYSE'], ['MO', 'Altria Group Inc.', 'NYSE'],
  ['TJX', 'TJX Companies Inc.', 'NYSE'], ['ROST', 'Ross Stores Inc.'],
  ['DG', 'Dollar General Corporation', 'NYSE'], ['EBAY', 'eBay Inc.'], ['ETSY', 'Etsy Inc.'],
  ['ZM', 'Zoom Communications Inc.'], ['DOCU', 'Docusign Inc.'], ['CRWD', 'CrowdStrike Holdings Inc.'],
  ['PANW', 'Palo Alto Networks Inc.'], ['FTNT', 'Fortinet Inc.'], ['ZS', 'Zscaler Inc.'],
  ['NET', 'Cloudflare Inc.', 'NYSE'], ['DDOG', 'Datadog Inc.'], ['MDB', 'MongoDB Inc.'],
  ['TEAM', 'Atlassian Corporation'], ['WDAY', 'Workday Inc.'], ['ADSK', 'Autodesk Inc.'],
  ['ANET', 'Arista Networks Inc.', 'NYSE'], ['MRVL', 'Marvell Technology Inc.'],
  ['ON', 'ON Semiconductor Corporation'], ['NXPI', 'NXP Semiconductors N.V.'], ['ASML', 'ASML Holding N.V.'],
  ['TSM', 'Taiwan Semiconductor Manufacturing Company', 'NYSE'], ['BABA', 'Alibaba Group Holding Limited', 'NYSE'],
  ['PDD', 'PDD Holdings Inc.'], ['JD', 'JD.com Inc.'], ['NIO', 'NIO Inc.', 'NYSE'],
  ['SE', 'Sea Limited', 'NYSE'], ['MELI', 'MercadoLibre Inc.'], ['SPOT', 'Spotify Technology S.A.', 'NYSE'],
  ['SONY', 'Sony Group Corporation', 'NYSE'], ['TM', 'Toyota Motor Corporation', 'NYSE'],
  ['HDB', 'HDFC Bank Limited', 'NYSE'], ['IBN', 'ICICI Bank Limited', 'NYSE'],
  ['INFY', 'Infosys Limited', 'NYSE'], ['WIT', 'Wipro Limited', 'NYSE'],
  ['RY', 'Royal Bank of Canada', 'NYSE'], ['TD', 'Toronto-Dominion Bank', 'NYSE'],
  ['SHEL', 'Shell plc', 'NYSE'], ['BP', 'BP p.l.c.', 'NYSE'], ['TTE', 'TotalEnergies SE', 'NYSE'],
  ['UL', 'Unilever PLC', 'NYSE'], ['AZN', 'AstraZeneca PLC'], ['NVS', 'Novartis AG', 'NYSE'],
  ['NVO', 'Novo Nordisk A/S', 'NYSE'], ['SAP', 'SAP SE', 'NYSE'], ['HSBC', 'HSBC Holdings plc', 'NYSE'],
  ['BCS', 'Barclays PLC', 'NYSE'], ['DB', 'Deutsche Bank Aktiengesellschaft', 'NYSE'],
  ['UBS', 'UBS Group AG', 'NYSE'], ['RELIANCE.NS', 'Reliance Industries Limited', 'NSE'],
  ['TCS.NS', 'Tata Consultancy Services Limited', 'NSE'], ['HDFCBANK.NS', 'HDFC Bank Limited', 'NSE'],
  ['INFY.NS', 'Infosys Limited', 'NSE'], ['ICICIBANK.NS', 'ICICI Bank Limited', 'NSE'],
  ['2222.SR', 'Saudi Arabian Oil Company (Aramco)', 'Saudi'], ['EMAAR.AE', 'Emaar Properties PJSC', 'Dubai']
]);

etf([
  ['SPY', 'SPDR S&P 500 ETF Trust'], ['VOO', 'Vanguard S&P 500 ETF'], ['IVV', 'iShares Core S&P 500 ETF'],
  ['VTI', 'Vanguard Total Stock Market ETF'], ['QQQ', 'Invesco QQQ Trust', 'NASDAQ'],
  ['VUG', 'Vanguard Growth ETF'], ['VTV', 'Vanguard Value ETF'],
  ['VEA', 'Vanguard FTSE Developed Markets ETF'], ['VWO', 'Vanguard FTSE Emerging Markets ETF'],
  ['VXUS', 'Vanguard Total International Stock ETF'], ['BND', 'Vanguard Total Bond Market ETF'],
  ['AGG', 'iShares Core U.S. Aggregate Bond ETF'], ['IEFA', 'iShares Core MSCI EAFE ETF'],
  ['IEMG', 'iShares Core MSCI Emerging Markets ETF'], ['IWM', 'iShares Russell 2000 ETF'],
  ['IWF', 'iShares Russell 1000 Growth ETF'], ['DIA', 'SPDR Dow Jones Industrial Average ETF Trust'],
  ['GLD', 'SPDR Gold Shares'], ['IAU', 'iShares Gold Trust'], ['SLV', 'iShares Silver Trust'],
  ['ARKK', 'ARK Innovation ETF'], ['SCHD', 'Schwab U.S. Dividend Equity ETF'],
  ['VYM', 'Vanguard High Dividend Yield ETF'], ['VIG', 'Vanguard Dividend Appreciation ETF'],
  ['XLK', 'Technology Select Sector SPDR Fund'], ['XLF', 'Financial Select Sector SPDR Fund'],
  ['XLE', 'Energy Select Sector SPDR Fund'], ['XLV', 'Health Care Select Sector SPDR Fund'],
  ['SMH', 'VanEck Semiconductor ETF'], ['SOXX', 'iShares Semiconductor ETF'],
  ['TLT', 'iShares 20+ Year Treasury Bond ETF'], ['HYG', 'iShares iBoxx High Yield Corporate Bond ETF'],
  ['LQD', 'iShares iBoxx Investment Grade Corporate Bond ETF'], ['EFA', 'iShares MSCI EAFE ETF'],
  ['EEM', 'iShares MSCI Emerging Markets ETF'], ['VNQ', 'Vanguard Real Estate ETF'],
  ['BITO', 'ProShares Bitcoin Strategy ETF'], ['IBIT', 'iShares Bitcoin Trust', 'NASDAQ'],
  ['FBTC', 'Fidelity Wise Origin Bitcoin Fund'],
  ['SPUS', 'SP Funds S&P 500 Sharia Industry Exclusions ETF'],
  ['SPSK', 'SP Funds Dow Jones Global Sukuk ETF'], ['SPRE', 'SP Funds S&P Global REIT Sharia ETF'],
  ['SPWO', 'SP Funds S&P World (ex-US) ETF'], ['SPTE', 'SP Funds S&P Global Technology ETF'],
  ['UMMA', 'Wahed Dow Jones Islamic World ETF', 'NASDAQ'],
  ['HLAL', 'Wahed FTSE USA Shariah ETF', 'NASDAQ'],
  ['ISDU', 'iShares MSCI USA Islamic UCITS ETF', 'LSE'],
  ['ISDE', 'iShares MSCI EM Islamic UCITS ETF', 'LSE'],
  ['ISWD', 'iShares MSCI World Islamic UCITS ETF', 'LSE'],
  ['IGDA', 'Invesco Dow Jones Islamic Global Developed Markets UCITS ETF', 'LSE']
]);

[
  ['BTC-USD', 'Bitcoin USD'], ['ETH-USD', 'Ethereum USD'], ['SOL-USD', 'Solana USD'],
  ['XRP-USD', 'XRP USD'], ['ADA-USD', 'Cardano USD'], ['DOGE-USD', 'Dogecoin USD'],
  ['BNB-USD', 'BNB USD'], ['AVAX-USD', 'Avalanche USD'], ['DOT-USD', 'Polkadot USD'],
  ['LTC-USD', 'Litecoin USD'], ['LINK-USD', 'Chainlink USD']
].forEach(([s, n]) => out.push(S(s, n, 'CCC', 'Crypto', 'USD')));

[
  ['^GSPC', 'S&P 500 Index'], ['^DJI', 'Dow Jones Industrial Average'], ['^IXIC', 'NASDAQ Composite'],
  ['^RUT', 'Russell 2000'], ['^FTSE', 'FTSE 100'], ['^N225', 'Nikkei 225'], ['^GDAXI', 'DAX Index'],
  ['^HSI', 'Hang Seng Index'], ['^NSEI', 'NIFTY 50'], ['^VIX', 'CBOE Volatility Index']
].forEach(([s, n]) => out.push(S(s, n, 'Index', 'Index', 'USD')));

[
  ['PKR=X', 'USD/PKR Exchange Rate'], ['EURUSD=X', 'EUR/USD Exchange Rate'],
  ['GBPUSD=X', 'GBP/USD Exchange Rate'], ['USDJPY=X', 'USD/JPY Exchange Rate'],
  ['INR=X', 'USD/INR Exchange Rate'], ['AED=X', 'USD/AED Exchange Rate'],
  ['SAR=X', 'USD/SAR Exchange Rate'], ['CAD=X', 'USD/CAD Exchange Rate']
].forEach(([s, n]) => out.push(S(s, n, 'FX', 'Currency', 'USD')));

// Yahoo only knows London listings by their .L suffix - a bare "ISDU" resolves
// to nothing, which is why the Islamic UCITS ETFs could not be priced. Give
// every LSE row the symbol Yahoo actually answers to, while keeping the plain
// ticker as the one shown and stored.
const YAHOO_SUFFIX = { LSE: '.L' };
out.forEach((a) => {
  const suffix = YAHOO_SUFFIX[a.exchange];
  if (suffix && !a.symbol.endsWith(suffix)) a.yahooSymbol = a.symbol + suffix;
});

const seen = new Set();
const deduped = out.filter((a) => (seen.has(a.symbol) ? false : seen.add(a.symbol)));

fs.writeFileSync(path.join(__dirname, 'international.json'), JSON.stringify(deduped));
const counts = {};
deduped.forEach((a) => { counts[a.type] = (counts[a.type] || 0) + 1; });
console.log('seed entries:', deduped.length, counts);
