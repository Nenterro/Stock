const fs = require('fs');
const html = fs.readFileSync('scratch/sarmaaya_mf.html', 'utf8');
const rsMatches = [...html.matchAll(/Rs\.?\s*([\d,]+\.[\d]+)/gi)];
console.log('Rs matches:', rsMatches.map(m => m[1]));

const pkrMatches = [...html.matchAll(/PKR\s*([\d,]+\.[\d]+)/gi)];
console.log('PKR matches:', pkrMatches.map(m => m[1]));
