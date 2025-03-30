const { createPublicClient, http } = require('viem');
const { gnosis } = require('viem/chains');
const { Client } = require('pg');

// Configuration PostgreSQL
const pgClient = new Client({
  host: "postgres",
  user: "nocodb",
  password: "nocodbpassword",
  database: "realtoken",
  port: 5432,
});

// Adresse du contrat RMM multicall
const RMM_CONTRACT_ADDRESS = '0x10497611Ee6524D75FC45E3739F472F83e282AD5';

// ABI pour la fonction getAllTokenBalancesOfUser (retourne [address[], uint256[]])
const rmmAbi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "user",
        "type": "address"
      }
    ],
    "name": "getAllTokenBalancesOfUser",
    "outputs": [
      {
        "internalType": "address[]",
        "name": "",
        "type": "address[]"
      },
      {
        "internalType": "uint256[]",
        "name": "",
        "type": "uint256[]"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];

// ABI minimal pour récupérer les decimals d'un token
const tokenAbi = [
  {
    "inputs": [],
    "name": "decimals",
    "outputs": [
      {
        "internalType": "uint8",
        "name": "",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
];

// Configuration des différents RPC pour Gnosis
const RPC_ENDPOINTS = [
  {
    name: "Gnosis Gateway",
    url: "https://rpc.gnosis.gateway.fm"
  },
  {
    name: "Gnosis Public",
    url: "https://rpc.gnosischain.com"
  }
];

// Création d'un client de test pour vérifier les RPC
let client = null;

// Fonction utilitaire pour ajouter un délai
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fonction pour exécuter une opération avec un timeout
const withTimeout = (promise, ms) => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Opération annulée après ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

// Fonction pour tester un RPC et créer un client fonctionnel
async function setupWorkingRPCClient() {
  console.log("🔍 Test des RPC Gnosis disponibles...");
  
  for (const rpc of RPC_ENDPOINTS) {
    try {
      console.log(`🔄 Test du RPC ${rpc.name} (${rpc.url})...`);
      
      const testClient = createPublicClient({
        chain: gnosis,
        transport: http(rpc.url, {
          timeout: 5000,
          retryCount: 1
        })
      });
      
      const blockNumber = await testClient.getBlockNumber();
      console.log(`✅ RPC ${rpc.name} opérationnel (bloc actuel: ${blockNumber})`);
      
      client = createPublicClient({
        chain: gnosis,
        transport: http(rpc.url, {
          timeout: 30000,
          retryCount: 3,
          retryDelay: 1000
        })
      });
      
      return true;
    } catch (err) {
      console.warn(`⚠️ RPC ${rpc.name} non disponible: ${err.message}`);
    }
  }
  
  console.error("❌ Aucun RPC disponible! Impossible de continuer.");
  return false;
}

// Cache pour les decimals des tokens
const tokenDecimalsCache = new Map();

// Récupérer les decimals d'un token
async function getTokenDecimals(tokenAddress) {
  if (tokenDecimalsCache.has(tokenAddress)) {
    return tokenDecimalsCache.get(tokenAddress);
  }
  
  try {
    const decimals = await client.readContract({
      address: tokenAddress,
      abi: tokenAbi,
      functionName: 'decimals'
    });
    
    console.log(`ℹ️ Token ${tokenAddress}: decimals = ${decimals}`);
    tokenDecimalsCache.set(tokenAddress, Number(decimals));
    return Number(decimals);
  } catch (err) {
    console.warn(`⚠️ Impossible de récupérer les decimals pour ${tokenAddress}, utilisation de 18 par défaut`);
    tokenDecimalsCache.set(tokenAddress, 18);
    return 18;
  }
}

// Connexion à PostgreSQL
async function connectToDB() {
  try {
    await pgClient.connect();
    console.log("🟢 Connexion PostgreSQL réussie.");
  } catch (error) {
    console.error("❌ Erreur de connexion à PostgreSQL:", error);
  }
}

// Récupération de la liste des wallets depuis PostgreSQL
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

// Récupérer les balances RMM pour un wallet en écartant les tokens spéciaux
// et en ne traitant pas ceux dont la balance est trop élevée (normalisée à 1)
async function getRMMBalancesForWallet(walletAddress) {
  try {
    console.log(`📡 Récupération des balances RMM pour ${walletAddress}...`);
    
    const result = await client.readContract({
      address: RMM_CONTRACT_ADDRESS,
      abi: rmmAbi,
      functionName: 'getAllTokenBalancesOfUser',
      args: [walletAddress]
    });
    
    const tokens = result[0];
    const balances = result[1];
    
    if (!tokens || tokens.length === 0) {
      console.log(`ℹ️ Aucune balance RMM trouvée pour ${walletAddress}`);
      return [];
    }
    
    console.log(`✅ ${tokens.length} balances RMM trouvées pour ${walletAddress}`);
    
    const processedBalances = [];
    for (let i = 0; i < tokens.length; i++) {
      const tokenAddress = tokens[i];
      const rawBalance = balances[i];
      
      // Écarter les tokens "spéciaux"
      if (tokenAddress.startsWith('0x000000000')) continue;
      
      if (rawBalance > 0n) {
        const rawBalanceStr = rawBalance.toString();
        
        // Écarter si la balance est trop élevée (pour éviter un montant normalisé à 1)
        if (rawBalanceStr.length > 30) continue;
        
        const amount = Number(rawBalance) / 1e18;
        if (!isFinite(amount) || amount < 0) continue;
        
        processedBalances.push({
          wallet: walletAddress,
          token: tokenAddress,
          amount_text: rawBalanceStr,
          amount: amount,
          is_special_address: false,
          type: 'RMM'
        });
      }
    }
    
    return processedBalances;
  } catch (err) {
    console.error(`❌ Erreur lors de la récupération des balances RMM pour ${walletAddress}:`, err.message);
    console.error(`  - Détails: ${err.stack}`);
    return [];
  }
}

// Met à jour le champ système "updated_at" pour tous les wallets récupérés
async function updateWalletsUpdatedAt(wallets) {
  if (!wallets.length) return;

  try {
    console.log(`🔄 Mise à jour du champ "updated_at" pour ${wallets.length} wallets...`);

    await pgClient.query(`
      CREATE TEMP TABLE temp_wallets (
        id int,
        updated_at timestamp DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const insertTempQuery = `
      INSERT INTO temp_wallets (id)
      VALUES ${wallets.map((_, i) => `($${i + 1})`).join(', ')}
    `;
    
    await pgClient.query(insertTempQuery, wallets.map(w => w.id));

    const updateQuery = `
      UPDATE address_list a
      SET updated_at = t.updated_at
      FROM temp_wallets t
      WHERE a.id = t.id
    `;

    const result = await pgClient.query(updateQuery);
    console.log(`✅ ${result.rowCount} wallets mis à jour`);

    await pgClient.query('DROP TABLE temp_wallets');
  } catch (err) {
    console.error("❌ Erreur lors de la mise à jour d'updated_at:", err);
    await pgClient.query('DROP TABLE IF EXISTS temp_wallets');
  }
}

// Stocker les balances dans la base de données
async function storeBalances(records) {
  if (records.length === 0) {
    console.log("🚀 Aucune balance à stocker.");
    return;
  }

  try {
    const uniqueWallets = [...new Set(records.map(r => r.wallet.toLowerCase()))];
    console.log(`📊 Traitement de ${records.length} balances pour ${uniqueWallets.length} wallets uniques.`);
    
    try {
      await pgClient.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'token_balances' AND column_name = 'amount_text'
          ) THEN
            ALTER TABLE token_balances ADD COLUMN amount_text TEXT;
          END IF;
          
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'token_balances' AND column_name = 'is_special_address'
          ) THEN
            ALTER TABLE token_balances ADD COLUMN is_special_address BOOLEAN DEFAULT FALSE;
          END IF;
        END $$;
      `);
      console.log("✅ Vérification/création des colonnes supplémentaires effectuée.");
    } catch (err) {
      console.warn("⚠️ Erreur lors de la vérification/création des colonnes:", err.message);
    }
    
    if (uniqueWallets.length > 0) {
      console.log(`🗑️ Suppression des anciens enregistrements RMM pour ${uniqueWallets.length} wallets...`);
      const params = uniqueWallets.map((_, idx) => `$${idx + 1}`).join(',');
      const deleteQuery = `
        DELETE FROM token_balances
        WHERE LOWER(wallet) IN (${params})
        AND type = 'RMM'
      `;
      
      const deleteResult = await pgClient.query(deleteQuery, uniqueWallets);
      console.log(`✅ ${deleteResult.rowCount} anciens enregistrements supprimés.`);
    }
    
    if (records.length > 0) {
      console.log(`➕ Insertion de ${records.length} nouveaux enregistrements RMM...`);
      
      const validRecords = records.filter(r => {
        if (isNaN(r.amount) || !isFinite(r.amount)) {
          console.warn(`⚠️ Valeur ignorée (non numérique): wallet=${r.wallet}, token=${r.token}, amount=${r.amount}`);
          return false;
        }
        if (r.amount < 0) {
          console.warn(`⚠️ Valeur ignorée (négative): wallet=${r.wallet}, token=${r.token}, amount=${r.amount}`);
          return false;
        }
        return true;
      });
      
      console.log(`📊 ${validRecords.length}/${records.length} enregistrements valides.`);
      
      const BATCH_SIZE = 25;
      for (let i = 0; i < validRecords.length; i += BATCH_SIZE) {
        const batch = validRecords.slice(i, i + BATCH_SIZE);
        
        const insertQuery = `
          INSERT INTO token_balances (wallet, token, amount, amount_text, is_special_address, type)
          VALUES ${batch.map((_, idx) => 
            `($${idx * 6 + 1}, $${idx * 6 + 2}, $${idx * 6 + 3}, $${idx * 6 + 4}, $${idx * 6 + 5}, $${idx * 6 + 6})`
          ).join(', ')}
        `;
        
        const values = batch.flatMap(r => [
          r.wallet.toLowerCase(),
          r.token,
          r.amount,
          r.amount_text,
          r.is_special_address || false,
          'RMM'
        ]);
        
        try {
          const insertResult = await pgClient.query(insertQuery, values);
          console.log(`✅ Lot ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(validRecords.length / BATCH_SIZE)}: ${insertResult.rowCount} enregistrements insérés.`);
        } catch (err) {
          console.error(`❌ Erreur d'insertion du lot ${Math.floor(i / BATCH_SIZE) + 1}:`, err.message);
          console.log("Tentative d'insertion enregistrement par enregistrement...");
          
          let successCount = 0;
          let failureCount = 0;
          for (let j = 0; j < batch.length; j++) {
            try {
              const record = batch[j];
              const singleInsertQuery = `
                INSERT INTO token_balances (wallet, token, amount, amount_text, is_special_address, type)
                VALUES ($1, $2, $3, $4, $5, $6)
              `;
              await pgClient.query(singleInsertQuery, [
                record.wallet.toLowerCase(),
                record.token,
                record.amount,
                record.amount_text,
                record.is_special_address || false,
                'RMM'
              ]);
              successCount++;
            } catch (singleErr) {
              console.error(`  - Erreur sur l'enregistrement ${j}:`, singleErr.message);
              failureCount++;
            }
          }
          console.log(`  - Insertions individuelles: ${successCount} réussies, ${failureCount} échouées`);
        }
      }
    }
    
    console.log(`✅ Synchronisation RMM terminée avec succès: ${records.length} balances mises à jour.`);
  } catch (err) {
    console.error("❌ Erreur lors du stockage des balances RMM:", err.message);
    console.error("Stack trace:", err.stack);
  }
}

// Fonction principale
async function syncRMMBalances() {
  try {
    console.log("🚀 Démarrage du script RMM...");
    
    const rpcReady = await setupWorkingRPCClient();
    if (!rpcReady) {
      console.error("❌ Impossible de continuer sans RPC fonctionnel.");
      return;
    }
    
    await connectToDB();
    const wallets = await getWallets();
    
    if (!wallets.length) {
      console.warn("⚠️ Aucun wallet trouvé, arrêt du script.");
      return;
    }
    
    const WALLET_BATCH_SIZE = 10;
    const allBalances = [];
    
    for (const batch of batchArray(wallets, WALLET_BATCH_SIZE)) {
      console.log(`🔍 Traitement du lot de ${batch.length} wallets...`);
      
      const batchPromises = batch.map(async (wallet) => {
        const balances = await getRMMBalancesForWallet(wallet.address);
        return balances;
      });
      
      const batchResults = await Promise.all(batchPromises);
      const flattenedResults = batchResults.flat();
      allBalances.push(...flattenedResults);
      console.log(`📊 Total de balances RMM trouvées jusqu'à présent: ${allBalances.length}`);
      
      await delay(1000);
    }
    
    if (allBalances.length > 0) {
      await storeBalances(allBalances);
    } else {
      console.log("ℹ️ Aucune balance RMM trouvée pour tous les wallets.");
    }
    
    console.log("✅ Synchronisation des balances RMM terminée.");
  } catch (err) {
    console.error("❌ Erreur dans le script RMM:", err.message);
    console.error('Stack trace:', err.stack);
  } finally {
    await pgClient.end();
  }
}

syncRMMBalances();
