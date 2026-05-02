const WALLET_ADDRESS = 'qMi2n_owlZP5ab2bTOyydn78cFwyxPanLlsZjgJLlHA';

async function getMyTransactions() {
  const query = `{
    transactions(
      owners: ["${WALLET_ADDRESS}"]
      first: 10
      sort: HEIGHT_DESC
    ) {
      edges {
        node {
          id
          tags { name value }
          block { height timestamp }
        }
      }
    }
  }`;

  const res = await fetch('https://arweave.net/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });

  const json = await res.json();
  
  if (json.data.transactions.edges.length === 0) {
    console.log('No transactions found on arweave.net');
    console.log('Trying goldsky...');
    await tryGoldsky();
  } else {
    console.log('Found:', JSON.stringify(json, null, 2));
  }
}

async function tryGoldsky() {
  const query = `{
    transactions(
      owners: ["${WALLET_ADDRESS}"]
      first: 5
    ) {
      edges {
        node { id tags { name value } }
      }
    }
  }`;

  const res = await fetch('https://arweave-search.goldsky.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });

  const json = await res.json();
  console.log('Goldsky result:', JSON.stringify(json, null, 2));
}

async function main() {
  console.log('Wallet:', WALLET_ADDRESS);
  try {
    await getMyTransactions();
  } catch(e) {
    console.log('Error:', e.message);
  }
}

main();
