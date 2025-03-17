const { Pool } = require('pg');

// === CONFIGURATION ===
const GRAPHQL_ENDPOINT = "https://gateway-arbitrum.network.thegraph.com/api/c4a3fd07adb1e3307ca045f5881cbade/subgraphs/id/FPPoFB7S2dcCNrRyjM5QbaMwKqRZPdbTg8ysBrwXd4SP";

// Configuration PostgreSQL
const pool = new Pool({
  host: 'postgres',
  database: 'realtoken',
  user: 'nocodb',
  password: 'nocodbpassword',
  port: 5432,
});

const query = `
query GetTransferEvents($tokenAddresses: [String!], $destinations: [String!], $skip: Int!) {
  transferEvents(
    where: { token_in: $tokenAddresses, destination_in: $destinations }
    orderBy: timestamp
    orderDirection: desc
    first: 1000
    skip: $skip
  ) {
    id token { id } amount sender destination timestamp transaction { id }
  }
}`;

async function getWalletsAndTokens() {
  try {
    console.log("📤 Récupération des wallets et tokens depuis PostgreSQL...");
    const client = await pool.connect();
    try {
      const [walletsResult, tokensResult] = await Promise.all([
        client.query('SELECT address FROM address_list'),
        client.query('SELECT "uuid" FROM real_tokens')
      ]);

      const destinations = walletsResult.rows
        .map(rec => rec.address?.toLowerCase())
        .filter(Boolean);
      const tokenAddresses = tokensResult.rows
        .map(rec => rec.uuid?.toLowerCase())
        .filter(Boolean);

      console.log(`✅ ${destinations.length} wallets et ${tokenAddresses.length} tokens récupérés.`);
      console.log("🔍 Tokens trouvés:", tokenAddresses);
      return { destinations, tokenAddresses };
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("❌ Erreur lors de la récupération des wallets/tokens:", err.message);
    console.error("❌ Stack trace:", err.stack);
    return { destinations: [], tokenAddresses: [] };
  }
}

async function fetchTransactions(tokenAddresses, destinations, skip = 0) {
  try {
    const variables = { tokenAddresses, destinations, skip };
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables })
    });
    if (!response.ok) throw new Error(`GraphQL query failed`);
    
    const data = await response.json();
    return data.data.transferEvents;
  } catch (err) {
    console.error("❌ Erreur lors de la récupération des transactions:", err.message);
    return [];
  }
}

async function getExistingTransactionIds() {
  const existingIds = new Set();

  console.log("📤 Récupération des transactions existantes depuis PostgreSQL...");
  try {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT "Transaction ID" FROM transactions_history');
      
      result.rows.forEach(rec => {
        if (rec["Transaction ID"]) {
          existingIds.add(rec["Transaction ID"].toLowerCase().trim());
        }
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`❌ Erreur dans getExistingTransactionIds: ${err.message}`);
  }

  console.log(`✅ ${existingIds.size} transactions déjà stockées.`);
  return existingIds;
}

async function storeTransactions(records) {
  if (records.length === 0) {
    console.log("🚀 Aucune nouvelle transaction à stocker.");
    return;
  }

  try {
    const client = await pool.connect();
    try {
      // Création d'une table temporaire pour le batch insert
      await client.query(`
        CREATE TEMP TABLE temp_transactions (
          \"Transaction ID\" VARCHAR(255),
          \"Token ID\" VARCHAR(255),
          amount DECIMAL(20,4),
          sender VARCHAR(255),
          destination VARCHAR(255),
          timestamp VARCHAR(255),
          \"Transaction Hash\" VARCHAR(255)
        )
      `);

      // Insertion des données dans la table temporaire
      for (const record of records) {
        await client.query(`
          INSERT INTO temp_transactions (
            \"Transaction ID\", \"Token ID\", amount, sender, destination,
            timestamp, \"Transaction Hash\"
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          record.transactionId,
          record.tokenId,
          record.amount,
          record.sender,
          record.destination,
          record.timestamp,
          record.transactionHash
        ]);
      }

      // Insertion des données de la table temporaire vers la table principale
      await client.query(`
        INSERT INTO transactions_history (
          \"Transaction ID\", \"Token ID\", amount, sender, destination,
          timestamp, \"Transaction Hash\"
        )
        SELECT * FROM temp_transactions
      `);

      console.log(`✅ ${records.length} nouvelles transactions ajoutées.`);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("❌ Erreur lors du stockage des transactions:", err.message);
  }
}

async function main() {
  try {
    console.log("🚀 Démarrage du script...");
    const { destinations, tokenAddresses } = await getWalletsAndTokens();
    if (!destinations.length || !tokenAddresses.length) {
      console.warn("⚠️ Aucun wallet ou token trouvé, arrêt du script.");
      return;
    }

    let allTransactions = [], skip = 0, fetched;
    do {
      const transactions = await fetchTransactions(tokenAddresses, destinations, skip);
      fetched = transactions.length;
      allTransactions = allTransactions.concat(transactions);
      skip += 1000;
    } while (fetched === 1000);

    console.log(`📦 ${allTransactions.length} transactions récupérées.`);
    const existingIds = await getExistingTransactionIds();
    const newRecords = allTransactions.filter(tx => !existingIds.has(tx.id.toLowerCase()))
      .map(tx => ({
        transactionId: tx.id,
        tokenId: tx.token.id,
        amount: tx.amount,
        sender: tx.sender,
        destination: tx.destination,
        timestamp: tx.timestamp,
        transactionHash: tx.transaction.id
      }));

    console.log(`🔍 ${newRecords.length} transactions à insérer après filtrage.`);
    await storeTransactions(newRecords);
  } catch (err) {
    console.error("❌ Erreur dans le script:", err.message);
  } finally {
    await pool.end();
  }
}

main();
