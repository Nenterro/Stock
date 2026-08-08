fetch("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d").then(r=>console.log(r.status)).catch(console.error);
