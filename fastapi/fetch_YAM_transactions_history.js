// Importation de Winston pour le logging
const winston = require('winston');
const { Pool } = require('pg');
const { pow } = Math;

// Configuration du logger avec Winston
const logger = winston.createLogger({
  level: 'info', // Peut être ajusté à 'debug' en phase de développement
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `[${level.toUpperCase()}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    // Vous pouvez activer le logging dans un fichier en décommentant la ligne suivante :
    // new winston.transports.File({ filename: 'app.log' })
  ]
});

logger.info('========================================================================================');
logger.info('=============================== YAM Transactions History ===============================');
logger.info('========================================================================================')


// === CONFIGURATION ===

// Endpoint TheGraph
const GRAPHQL_ENDPOINT = "https://gateway-arbitrum.network.thegraph.com/api/ae36a6bfa6af7dfa3487d2cecf583ebe/subgraphs/id/4eJa4rKCR5f8fq48BKbYBPvf7DWHppGZRvfiVUSFXBGR";

// Configuration PostgreSQL
const pool = new Pool({
  host: 'postgres',
  database: 'realtoken',
  user: 'nocodb',
  password: 'nocodbpassword',
  port: 5432,
});

// === QUERY TheGraph ===

const query = `
query GetYamTransactions($accountIds: [String!]!, $skip: Int!) {
  accounts(where: {id_in: $accountIds}) {
    id
    transactions(first: 1000, skip: $skip) {
      id
      price
      quantity
      taker { address }
      createdAtTimestamp
      offer {
        id
        offerToken { address decimals }
        buyerToken { address decimals }
        maker { address }
      }
    }
  }
}
`;

/**
 * Récupère les wallets depuis la table PostgreSQL.
 * @returns {Promise<Array<string>>} - Un tableau d'adresses Ethereum en minuscules.
 */
async function getWallets() {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT address FROM address_list');
      const wallets = result.rows
        .map(rec => rec.address && rec.address.toLowerCase())
        .filter(address => address);
      logger.info(`Récupération de ${wallets.length} wallets depuis PostgreSQL.`);
      return wallets;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error(`Erreur lors de la récupération des wallets depuis PostgreSQL: ${err.message}`);
    return [];
  }
}

/**
 * Exécute la query TheGraph pour récupérer les transactions pour les comptes spécifiés.
 * @param {Array<string>} accountIds - Liste des comptes (wallets).
 * @param {number} skip - Nombre d'éléments à sauter (pagination).
 * @returns {Promise<Array>} - Tableau des comptes avec leurs transactions.
 */
async function fetchYamTransactions(accountIds, skip = 0) {
  const variables = { accountIds, skip };

  try {
    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`GraphQL query failed: ${errorText}`);
    }

    const data = await response.json();
    return data.data.accounts;
  } catch (err) {
    logger.error(`Erreur lors de la récupération des transactions depuis TheGraph: ${err.message}`);
    throw err;
  }
}

/**
 * Récupère tous les enregistrements existants dans la table PostgreSQL
 * et construit un ensemble de clés composites au format "accountId_transactionId".
 */
async function getAllExistingTransactionKeys() {
  const existingKeys = new Set();

  logger.info("Récupération de tous les enregistrements de transactions depuis PostgreSQL...");

  try {
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT account_id, transaction_id FROM yam_transactions_history');
      
      result.rows.forEach(rec => {
        const accountId = rec.account_id?.toLowerCase().trim();
        const transactionId = rec.transaction_id?.toLowerCase().trim();

        if (!accountId || !transactionId) {
          logger.warn(`Transaction ignorée (champs manquants) : ${JSON.stringify(rec)}`);
          return;
        }
        existingKeys.add(`${accountId}_${transactionId}`);
      });

      logger.info(`Nombre total d'enregistrements existants récupérés: ${existingKeys.size}`);
      return existingKeys;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error(`Erreur dans getAllExistingTransactionKeys: ${err.message}`);
    throw err;
  }
}

/**
 * Envoie les enregistrements dans la table PostgreSQL.
 * @param {Array<Object>} records - Tableau d'enregistrements à insérer.
 */
async function storeTransactions(records) {
  try {
    const client = await pool.connect();
    try {
      // Création d'une table temporaire pour le batch insert
      await client.query(`
        CREATE TEMP TABLE temp_yam_transactions (
          account_id text,
          transaction_id text,
          price numeric,
          quantity numeric,
          taker text,
          timestamp text,
          offer_id text,
          offer_token_address text,
          buyer_token_address text,
          maker text
        )
      `);

      // Insertion des données dans la table temporaire
      for (const record of records) {
        await client.query(`
          INSERT INTO temp_yam_transactions (
            account_id, transaction_id, price, quantity, taker,
            timestamp, offer_id, offer_token_address,
            buyer_token_address, maker
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `, [
          record.accountId,
          record.transactionId,
          record.price,
          record.quantity,
          record.taker,
          record.createdAtTimestamp,
          record.offerId,
          record.offerTokenAddress,
          record.buyerTokenAddress,
          record.maker
        ]);
      }

      // Insertion des données de la table temporaire vers la table principale
      await client.query(`
        INSERT INTO yam_transactions_history (
          account_id, transaction_id, price, quantity, taker,
          timestamp, offer_id, offer_token_address,
          buyer_token_address, maker
        )
        SELECT * FROM temp_yam_transactions
      `);

      logger.info("Insertion des transactions réussie.");
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error(`Erreur lors du stockage des transactions: ${err.message}`);
    throw err;
  }
}

/**
 * Fonction principale pour récupérer, convertir et stocker les transactions,
 * en évitant les doublons basés sur la combinaison transactionId et accountId.
 */
async function main() {
  try {
    const wallets = await getWallets();
    if (wallets.length === 0) {
      logger.info("Aucun wallet trouvé dans PostgreSQL.");
      return;
    }

    const accounts = await fetchYamTransactions(wallets, 0);
    logger.info(`Accounts récupérés: ${JSON.stringify(accounts.map(acc => acc.id))}`);

    const records = [];
    for (const account of accounts) {
      const accountId = account.id;
      if (account.transactions) {
        for (const tx of account.transactions) {
          // Conversion des champs price et quantity en fonction des décimales
          const buyerTokenDecimals = tx.offer && tx.offer.buyerToken 
            ? parseInt(tx.offer.buyerToken.decimals) || 6 
            : 6;
          const offerTokenDecimals = tx.offer && tx.offer.offerToken 
            ? parseInt(tx.offer.offerToken.decimals) || 18 
            : 18;
          
          const convertedPrice = parseFloat(tx.price) / pow(10, buyerTokenDecimals);
          const convertedQuantity = parseFloat(tx.quantity) / pow(10, offerTokenDecimals);
          
          const record = {
            accountId: accountId,
            transactionId: tx.id,
            price: convertedPrice,
            quantity: convertedQuantity,
            taker: tx.taker ? tx.taker.address : null,
            createdAtTimestamp: tx.createdAtTimestamp,
            offerId: tx.offer ? tx.offer.id : null,
            offerTokenAddress: tx.offer && tx.offer.offerToken ? tx.offer.offerToken.address : null,
            buyerTokenAddress: tx.offer && tx.offer.buyerToken ? tx.offer.buyerToken.address : null,
            maker: tx.offer && tx.offer.maker ? tx.offer.maker.address : null
          };
          records.push(record);
        }
      }
    }

    // Récupération des clés composites des transactions existantes pour éviter les doublons
    const existingKeys = await getAllExistingTransactionKeys();
    const newRecords = records.filter(r => {
      const key = `${r.accountId.toLowerCase().trim()}_${r.transactionId.toLowerCase().trim()}`;
      return !existingKeys.has(key);
    });
    logger.info(`Nombre de nouvelles transactions à insérer : ${newRecords.length}`);

    if (newRecords.length > 0) {
      await storeTransactions(newRecords);
    } else {
      logger.info("Aucune nouvelle transaction à insérer.");
    }
  } catch (err) {
    logger.error(`Erreur dans main: ${err.message}`);
  } finally {
    await pool.end();
  }
}

// Lancer le script
main();
