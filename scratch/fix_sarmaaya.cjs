const fs = require('fs');
let code = fs.readFileSync('server/index.js', 'utf8');

// Move LOCAL_ASSET_DATABASE
const startMatch = code.indexOf('const LOCAL_ASSET_DATABASE = [');
const endStr = '  // 3. Yahoo Finance search fallback for global assets';
const endMatch = code.indexOf(endStr);
if (startMatch !== -1 && endMatch !== -1) {
    // Extract everything from startMatch to endMatch (except the catch block before endStr)
    const exactEndStr = '} catch (e) {}\\n\\n      // 3. Yahoo';
    let realEnd = code.indexOf('} catch (e) {}', startMatch);
    if (realEnd === -1) {
       console.log('Failed to find catch block');
       process.exit(1);
    }
    realEnd += '} catch (e) {}'.length;
    
    const dbCode = code.substring(startMatch, realEnd);
    
    // Remove it from inside the server block
    code = code.replace(dbCode, '');
    
    // Insert it after the requires
    const requireEnd = code.lastIndexOf('require(') + 50;
    const insertPoint = code.indexOf('\n', requireEnd);
    
    // unindent dbCode by 2 spaces
    const unindentedDbCode = dbCode.split('\n').map(l => l.startsWith('  ') ? l.substring(2) : l).join('\n');
    
    code = code.substring(0, insertPoint) + '\n\n// Global Database\n' + unindentedDbCode + '\n' + code.substring(insertPoint);
    
    // Now add logic to fetchSarmaayaQuote
    const targetSlugCode = '    `https://sarmaaya.pk/mutual-funds/details/${encodeURIComponent(slug)}`\n  ];';
    const newSlugCode = targetSlugCode + '\n\n  // Auto-resolve Mutual Fund full name slug\n  const dbAsset = typeof LOCAL_ASSET_DATABASE !== "undefined" ? LOCAL_ASSET_DATABASE.find(a => a.symbol.toUpperCase() === cleanSym) : null;\n  if (dbAsset && dbAsset.type && dbAsset.type.includes("Mutual Fund")) {\n    const nameSlug = dbAsset.name.replace(/\\([^)]+\\)/g, "").trim().toLowerCase().replace(/\\s+/g, "-");\n    candidateUrls.push(`https://sarmaaya.pk/mutual-funds/${encodeURIComponent(nameSlug)}`);\n    candidateUrls.push(`https://sarmaaya.pk/mutual-funds/details/${encodeURIComponent(nameSlug)}`);\n  }';
    
    code = code.replace(targetSlugCode, newSlugCode);
    
    fs.writeFileSync('server/index.js', code);
    console.log('Successfully refactored index.js');
} else {
    console.log('Could not find boundaries');
}
