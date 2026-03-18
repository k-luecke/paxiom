import { execSync } from 'child_process';
import { readFileSync, statSync } from 'fs';

const LOG_FILE = '/home/mk19/paxiom/opportunities.log';
const MIN_SPREAD = 0.06; // only check spreads above this
let lastSize = 0;
let lastChecked = '';

function runForkTest(opportunity) {
  const { asset, spreadPct, buyChain, buyDex, sellChain, sellDex, buyPrice, sellPrice } = opportunity;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`CHECKING: ${asset} ${spreadPct}%`);
  console.log(`Buy:  ${buyChain}/${buyDex} @ $${buyPrice}`);
  console.log(`Sell: ${sellChain}/${sellDex} @ $${sellPrice}`);
  console.log(`Time: ${opportunity.timestamp}`);
  console.log('='.repeat(60));

  // Only test Base same-chain opportunities with forge
  if (buyChain === 'base' && sellChain === 'base') {
    const buyOnAerodrome = buyDex === 'aerodrome';
    console.log('Same chain Base opportunity — running fork test...');
    try {
      const result = execSync(
        `cd /home/mk19/paxiom/contracts && forge test --fork-url https://mainnet.base.org -vv --match-contract PaxiomFlashLoanTest 2>&1`,
        { timeout: 60000, encoding: 'utf8' }
      );
      const profitMatch = result.match(/PROFIT.*?(\d+)/);
      const lossMatch = result.match(/LOSS.*?(\d+)/);
      if (profitMatch) {
        console.log(`✅ PROFITABLE: $${profitMatch[1]} USDC`);
      } else if (lossMatch) {
        console.log(`❌ Not profitable: $${lossMatch[1]} loss`);
      }
    } catch(e) {
      console.log('Fork test failed:', e.message.slice(0, 200));
    }
  } else {
    // Cross chain — just log the opportunity details
    console.log(`Cross chain opportunity — ${buyChain} → ${sellChain}`);
    console.log(`Spread: ${spreadPct}%`);
    const loan = 1000000;
    const gross = loan * (parseFloat(spreadPct) / 100);
    const fee = loan * 0.0005;
    const net = gross - fee - 50;
    console.log(`$1M loan estimate: ${net > 0 ? '✅ $' + net.toFixed(0) + ' net' : '❌ $' + Math.abs(net).toFixed(0) + ' loss'}`);
    console.log(`$5M loan estimate: ${((gross * 5) - (fee * 5) - 50) > 0 ? '✅ $' + ((gross * 5) - (fee * 5) - 50).toFixed(0) : '❌'}`);
  }
}

function checkLog() {
  try {
    const size = statSync(LOG_FILE).size;
    if (size <= lastSize) return;
    
    const content = readFileSync(LOG_FILE, 'utf8');
    const lines = content.trim().split('\n');
    const newLines = lines.slice(Math.max(0, lines.length - 10));
    
    for (const line of newLines) {
      try {
        const opp = JSON.parse(line);
        if (opp.timestamp === lastChecked) continue;
        if (parseFloat(opp.spreadPct) >= MIN_SPREAD) {
          lastChecked = opp.timestamp;
          runForkTest(opp);
        }
      } catch(e) {}
    }
    
    lastSize = size;
  } catch(e) {}
}

console.log(`Arb checker running — watching for spreads above ${MIN_SPREAD}%`);
console.log('Press Ctrl+C to stop\n');

// Check every 5 seconds
setInterval(checkLog, 5000);
checkLog();
