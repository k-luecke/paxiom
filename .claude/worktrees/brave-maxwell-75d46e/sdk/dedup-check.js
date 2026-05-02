import { readFileSync } from 'fs';

const LOG_FILE = '/home/mk19/paxiom/opportunities.log';

export function getLastLogged(asset, buyChain, sellChain) {
  try {
    const content = readFileSync(LOG_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.trim());
    
    // Search backwards for last matching entry
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.asset === asset && 
            entry.buyChain === buyChain && 
            entry.sellChain === sellChain) {
          return {
            spread: parseFloat(entry.spreadPct),
            timestamp: new Date(entry.timestamp).getTime()
          };
        }
      } catch(e) {}
    }
  } catch(e) {}
  return null;
}
