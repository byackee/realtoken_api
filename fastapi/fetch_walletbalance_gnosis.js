const { Client } = require('pg');

const GRAPHQL_ENDPOINT = "https://gateway-arbitrum.network.thegraph.com/api/c4a3fd07adb1e3307ca045f5881cbade/subgraphs/id/FPPoFB7S2dcCNrRyjM5QbaMwKqRZPdbTg8ysBrwXd4SP";

// Configuration PostgreSQL
const pgClient = new Client({
  host: "postgres",
  user: "nocodb",
  password: "nocodbpassword",
  database: "realtoken",
  port: 5432,
});

// Connexion à PostgreSQL
async function connectToDB() {
  try {
    await pgClient.connect();
    console.log("🟢 Connexion PostgreSQL réussie.");
  } catch (error) {
    console.error("❌ Erreur de connexion à PostgreSQL:", error);
  }
}

// Récupérer la liste des wallets
async function getWallets() {
  try {
    const query = `
      SELECT id, address
      FROM address_list
      WHERE id IS NOT NULL
    `;
    
    const result = await pgClient.query(query);
    const wallets = result.rows.map(rec => ({
      id: rec.id,
      address: rec.address.toLowerCase()
    }));
    
    console.log(`🗄️  Récupération de ${wallets.length} wallets`);
    await updateWalletsUpdatedAt(wallets);
    return wallets;
  } catch (err) {
    console.error("❌ Erreur lors de la récupération des wallets:", err);
    return [];
  }
}

// Découpe un tableau en lots
function batchArray(arr, batchSize) {
  const batches = [];
  for (let i = 0; i < arr.length; i += batchSize) {
    batches.push(arr.slice(i, i + batchSize));
  }
  return batches;
}

// Interroge TheGraph pour récupérer les balances d'un lot de wallets
async function queryGraphForBatch(addressBatch) {
  try {
    console.log(`📡 Interrogation de TheGraph pour ${addressBatch.length} adresses`);

    // Vérifier et filtrer les adresses invalides
    const validAddresses = addressBatch.filter(addr => /^0x[a-fA-F0-9]{40}$/.test(addr));

    if (validAddresses.length === 0) {
      console.warn("⚠️ Aucune adresse valide à envoyer à TheGraph !");
      return [];
    }

    console.log("🔍 Adresses envoyées à TheGraph:", validAddresses);

    const query = `
      query RealtokenQuery($addressList: [String]!) {
        accounts(where: { address_in: $addressList }) {
          address
          balances(where: { amount_gt: "0" }, first: 1000, orderBy: amount, orderDirection: desc) {
            token {
              address
            }
            amount
          }
        }
      }
    `;

    const response = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { addressList: validAddresses } })
    });

    if (!response.ok) {
      throw new Error(`Erreur GraphQL: ${await response.text()}`);
    }

    const responseData = await response.json();

    if (responseData.errors) {
      console.error("❌ Erreur GraphQL détectée:", responseData.errors);
      return [];
    }

    if (!responseData.data || !responseData.data.accounts) {
      console.warn("⚠️ Aucune donnée renvoyée par TheGraph");
      return [];
    }

    return responseData.data.accounts;
  } catch (err) {
    console.error("❌ Erreur dans la requête GraphQL:", err);
    return [];
  }
}

// Synchronise les balances des comptes
async function syncBalancesForAccounts(accounts) {
  const newRecordsMap = new Map();
  const activeWalletTokens = new Set();

  if (!accounts || accounts.length === 0) {
    console.warn("⚠️ Aucun compte trouvé dans la réponse GraphQL.");
    return;
  }

  for (const account of accounts) {
    if (!account || !account.address) {
      console.warn(`⚠️ Compte invalide reçu:`, account);
      continue;
    }

    const wallet = account.address.toLowerCase();

    if (!account.balances || account.balances.length === 0) {
      console.warn(`⚠️ Aucun solde trouvé pour le compte ${wallet}`);
      continue;
    }

    for (const balance of account.balances) {
      if (!balance.token || !balance.token.address) {
        console.warn(`⚠️ Balance invalide reçue:`, balance);
        continue;
      }

      const token = balance.token.address.toLowerCase();
      const amount = parseFloat(balance.amount);
      const type = "wallet";

      const key = `${wallet}_${token}_${amount}_${type}`;
      newRecordsMap.set(key, { wallet, token, amount, type });
      activeWalletTokens.add(`${wallet}_${token}`);
    }
  }

  const existingRecordsMap = await getExistingBalances();
  const recordsToUpdate = [];
  const recordsToInsert = [];
  const recordsToDelete = [];

  // Traiter les nouveaux enregistrements et les mises à jour
  for (const [key, newRecord] of newRecordsMap) {
    const walletTokenKey = `${newRecord.wallet}_${newRecord.token}`;
    
    // Chercher un enregistrement existant avec le même couple wallet_token
    let existingRecord = null;
    for (const [existingKey, record] of existingRecordsMap) {
      if (record.wallet === newRecord.wallet && record.token === newRecord.token) {
        existingRecord = record;
        existingRecordsMap.delete(existingKey);
        break;
      }
    }

    if (existingRecord) {
      // Mettre à jour l'enregistrement existant
      recordsToUpdate.push({ id: existingRecord.id, ...newRecord });
    } else {
      // Insérer un nouvel enregistrement
      recordsToInsert.push(newRecord);
    }
  }

  // Supprimer uniquement les enregistrements qui n'existent plus dans TheGraph
  for (const [key, rec] of existingRecordsMap) {
    const walletTokenKey = `${rec.wallet}_${rec.token}`;
    if (rec.type === "wallet" && !activeWalletTokens.has(walletTokenKey)) {
      recordsToDelete.push(rec.id);
    }
  }

  if (recordsToUpdate.length) await updateBalanceRecords(recordsToUpdate);
  if (recordsToInsert.length) await insertBalanceRecords(recordsToInsert);
  if (recordsToDelete.length) await deleteBalanceRecords(recordsToDelete);
}

// Récupération des enregistrements existants dans la table des balances
async function getExistingBalances() {
  const existingRecordsMap = new Map();
  try {
    console.log("🔄 Récupération des enregistrements existants...");

    const query = `
      SELECT id, lower(wallet) as wallet, lower(token) as token, amount, type
      FROM token_balances
      WHERE wallet IS NOT NULL AND token IS NOT NULL
    `;

    const result = await pgClient.query(query);
    
    for (const rec of result.rows) {
      const key = `${rec.wallet}_${rec.token}_${rec.amount}_${rec.type}`;
      existingRecordsMap.set(key, rec);
    }
  } catch (err) {
    console.error("❌ Erreur lors de la récupération des balances existantes:", err);
  }

  return existingRecordsMap;
}

// Mise à jour des enregistrements existants dans la table des balances
async function updateBalanceRecords(records) {
  try {
    if (records.length === 0) {
      console.warn("⚠️ Aucun enregistrement à mettre à jour.");
      return;
    }

    console.log(`🔄 Tentative de mise à jour de ${records.length} records`);

    // Créer une table temporaire pour les mises à jour
    await pgClient.query(`
      CREATE TEMP TABLE temp_balances (
        id int,
        wallet varchar(255),
        token varchar(255),
        amount decimal(12,4),
        type varchar(255)
      )
    `);

    // Insérer les données dans la table temporaire
    const insertTempQuery = `
      INSERT INTO temp_balances 
      VALUES ${records.map((_, i) => 
        `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`
      ).join(', ')}
    `;
    
    await pgClient.query(insertTempQuery, records.flatMap(r => [
      r.id,
      r.wallet,
      r.token,
      r.amount,
      r.type
    ]));

    // Mettre à jour les enregistrements
    const updateQuery = `
      UPDATE token_balances b
      SET 
        wallet = t.wallet,
        token = t.token,
        amount = t.amount,
        type = t.type
      FROM temp_balances t
      WHERE b.id = t.id
    `;

    const result = await pgClient.query(updateQuery);
    console.log(`✅ ${result.rowCount} enregistrements mis à jour`);

    // Nettoyer la table temporaire
    await pgClient.query('DROP TABLE temp_balances');
  } catch (err) {
    console.error("❌ Erreur lors de la mise à jour des records:", err);
    await pgClient.query('DROP TABLE IF EXISTS temp_balances');
  }
}

// Insère plusieurs enregistrements
async function insertBalanceRecords(records) {
  try {
    const insertQuery = `
      INSERT INTO token_balances (wallet, token, amount, type)
      VALUES ${records.map((_, i) => 
        `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`
      ).join(', ')}
    `;

    const values = records.flatMap(r => [
      r.wallet,
      r.token,
      r.amount,
      r.type
    ]);

    const result = await pgClient.query(insertQuery, values);
    console.log(`✅ ${result.rowCount} enregistrements insérés`);
  } catch (err) {
    console.error("❌ Erreur lors de l'insertion des records:", err);
  }
}

// Supprime plusieurs enregistrements en batch
async function deleteBalanceRecords(recordIds) {
  try {
    if (!recordIds.length) {
      console.warn("⚠️ Aucun record à supprimer.");
      return;
    }

    console.log(`🗑️ Suppression de ${recordIds.length} records...`);

    const deleteQuery = `
      DELETE FROM token_balances
      WHERE id = ANY($1)
    `;

    const result = await pgClient.query(deleteQuery, [recordIds]);
    console.log(`✅ ${result.rowCount} enregistrements supprimés`);
  } catch (err) {
    console.error("❌ Erreur lors de la suppression des records:", err);
  }
}

// Met à jour le champ système "updated_at" pour tous les wallets récupérés
async function updateWalletsUpdatedAt(wallets) {
  if (!wallets.length) return;

  try {
    console.log(`🔄 Mise à jour du champ "updated_at" pour ${wallets.length} wallets...`);

    // Créer une table temporaire pour les mises à jour
    await pgClient.query(`
      CREATE TEMP TABLE temp_wallets (
        id int,
        updated_at timestamp DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Insérer les données dans la table temporaire
    const insertTempQuery = `
      INSERT INTO temp_wallets (id)
      VALUES ${wallets.map((_, i) => `($${i + 1})`).join(', ')}
    `;
    
    await pgClient.query(insertTempQuery, wallets.map(w => w.id));

    // Mettre à jour les enregistrements
    const updateQuery = `
      UPDATE address_list a
      SET updated_at = t.updated_at
      FROM temp_wallets t
      WHERE a.id = t.id
    `;

    const result = await pgClient.query(updateQuery);
    console.log(`✅ ${result.rowCount} wallets mis à jour`);

    // Nettoyer la table temporaire
    await pgClient.query('DROP TABLE temp_wallets');
  } catch (err) {
    console.error("❌ Erreur lors de la mise à jour d'updated_at:", err);
    await pgClient.query('DROP TABLE IF EXISTS temp_wallets');
  }
}

// Fonction principale
async function syncWalletBalances() {
  await connectToDB();
  const wallets = await getWallets();
  if (!wallets.length) return;

  for (const batch of batchArray(wallets.map(w => w.address), 100)) {
    const accounts = await queryGraphForBatch(batch);
    if (accounts.length) {
      await syncBalancesForAccounts(accounts);
    }
  }

  console.log("✅ Synchronisation des balances terminée.");
  await pgClient.end();
}

syncWalletBalances();