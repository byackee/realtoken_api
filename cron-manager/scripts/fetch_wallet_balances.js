const { createPublicClient, http, createWalletClient, parseAbi } = require('viem');
const { gnosis } = require('viem/chains');
const { Pool } = require('pg');

// Configuration PostgreSQL
const pool = new Pool({
  host: 'postgres',
  database: 'realtoken',
  user: 'nocodb',
  password: 'nocodbpassword',
  port: 5432,
});

// ABI complet pour ERC20
const erc20Abi = [
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  }
];

// Configuration des différents RPC pour Gnosis
const RPC_ENDPOINTS = [
  {
    name: "Gnosis PublicNode",
    url: "https://gnosis-rpc.publicnode.com"
  },
  {
    name: "Gnosis Gateway",
    url: "https://rpc.gnosis.gateway.fm"
  },
  {
    name: "Backup HTTP RPC",
    url: "http://164.68.104.10:8443"
  },
];

// Référence du client disponible globalement
let activeClient = null;
// Compteur d'échecs consécutifs de RPC
let consecutiveRpcFailures = 0;
// Seuil d'échecs avant de lancer le script de secours
const MAX_RPC_FAILURES = 5;

// Liste des contrats problématiques à ignorer
const BLACKLISTED_CONTRACTS = [
  '0x021Bb23a45e9FC824260435e670fC383b7b8cbbB',
  '0x0643ffb30add44ef5c74996ad57a03a2244b6f28',
  '0x0675e8f4a52ea6c845cb6427af03616a2af42170',
  '0x06cc12368fA6A3D4dc0872C60331156a21cDcc9C',
  '0x06D0e5Aee443093aC5635B709C8a01342E59Df19',
  // Ajouter d'autres contrats problématiques ici
].map(addr => addr.toLowerCase());

// Liste dynamique des contrats problématiques découverts pendant l'exécution
const runtimeBlacklist = new Set();

// Fonction utilitaire pour ajouter un délai
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fonction pour obtenir un client pour notre RPC actif
function getClient() {
  if (!activeClient) {
    throw new Error("Aucun RPC actif disponible!");
  }
  return activeClient;
}

// Fonction pour créer une barre de progression
function createProgressBar(total, startTime, size = 30) {
  let lastProgress = -1;  // Pour éviter des mises à jour inutiles
  
  return {
    update: (current, wallet = '', positiveBalances = 0) => {
      const progress = Math.floor((current / total) * 100);
      const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
      
      // N'afficher que si le pourcentage a changé
      if (progress !== lastProgress || current === total) {
        const filled = Math.floor((current / total) * size);
        const bar = '█'.repeat(filled) + '░'.repeat(size - filled);
        // Effacer la ligne entière avant d'afficher
        process.stdout.write(`\r\x1b[K[${bar}] ${progress}% (${current}/${total}) Wallet: ${wallet.substring(0, 8)} Temps: ${elapsedSeconds}s`);
        lastProgress = progress;
      }
    },
    finish: () => {
      process.stdout.write('\n'); // Nouvelle ligne à la fin
    }
  };
}

// Fonction pour exécuter une opération avec un timeout
const withTimeout = (promise, ms) => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Opération annulée après ${ms}ms`));
    }, ms);
  });

  return Promise.race([
    promise,
    timeoutPromise,
  ]).finally(() => clearTimeout(timeoutId));
};

// Fonction pour exécuter une opération avec retry
async function withRetry(operation, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Attendre un délai exponentiel entre les tentatives (0ms, 1000ms, 2000ms)
      if (attempt > 0) {
        await delay(500 * attempt);
      }
      return await operation();
    } catch (error) {
      lastError = error;
      // Si ce n'est pas la dernière tentative, on continue
      if (attempt < maxRetries) {
        console.log(`⚠️ Tentative ${attempt + 1} échouée, nouvel essai...`);
      }
    }
  }
  throw lastError;
}

// Fonction pour lancer le script de secours
async function launchBackupScript() {
  console.log("⚠️ Trop d'échecs de RPC consécutifs, lancement du script de secours...");
  const { exec } = require('child_process');
  
  return new Promise((resolve, reject) => {
    exec('node fastapi/fetch_wallet_balances_alt.js', (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ Erreur lors de l'exécution du script de secours: ${error.message}`);
        reject(error);
        return;
      }
      if (stderr) {
        console.warn(`⚠️ Avertissements du script de secours: ${stderr}`);
      }
      console.log(`✅ Script de secours exécuté avec succès:\n${stdout}`);
      resolve();
    });
  });
}

async function getWalletsAndTokens() {
  try {
    console.log("📤 Récupération des wallets et tokens...");
    const client = await pool.connect();
    try {
      const [walletsResult, tokensResult] = await Promise.all([
        client.query('SELECT address FROM address_list'),
        client.query(`
          SELECT 
            gnosis_contract,
            symbol
          FROM real_tokens 
          WHERE gnosis_contract IS NOT NULL
        `)
      ]);

      const wallets = walletsResult.rows
        .map(rec => rec.address?.toLowerCase())
        .filter(Boolean);
      const tokens = tokensResult.rows
        .map(rec => ({
          address: rec.gnosis_contract,
          symbol: rec.symbol || 'UNKNOWN',
          decimals: 18 // Valeur par défaut fixe
        }))
        .filter(rec => rec.address);

      console.log(`✅ ${wallets.length} wallets et ${tokens.length} tokens récupérés.`);
      return { wallets, tokens };
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("❌ Erreur lors de la récupération des wallets/tokens:", err.message);
    return { wallets: [], tokens: [] };
  }
}

async function getBalancesInBatches(wallets, tokens, startTime) {
  const results = [];
  const OPERATION_TIMEOUT = 45000; // 45 secondes pour le traitement complet
  const errors = []; // Stocker les erreurs pour le résumé final
  const walletResults = {}; // Pour stocker les résultats par wallet
  
  // Filtrer les tokens pour exclure les contrats blacklistés
  const validTokens = tokens.filter(token => {
    const address = token.address.toLowerCase();
    return !BLACKLISTED_CONTRACTS.includes(address) && !runtimeBlacklist.has(address);
  });
  
  console.log(`✅ ${validTokens.length}/${tokens.length} tokens valides`);
  console.log("🔍 Début du traitement des wallets...");
  
  // Créer une barre de progression avec le temps écoulé
  const totalWallets = wallets.length;
  const progress = createProgressBar(totalWallets, startTime);
  let processedWallets = 0;
  
  // Traiter un wallet à la fois plutôt que de les paralléliser
  // pour éviter de surcharger le RPC
  for (let w = 0; w < wallets.length; w++) {
    const wallet = wallets[w];
    const shortenedWallet = wallet.substring(0, 8);
    
    try {
      // Obtenir le client actuel
      const client = getClient();
      
      // Préparer les contrats pour multicall - tous les tokens en une seule fois
      const contracts = validTokens.map(token => ({
        address: token.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [wallet]
      }));
      
      // Exécuter le multicall avec un timeout plus généreux
      const balances = await withTimeout(
        client.multicall({
          contracts,
          allowFailure: true,
        }),
        OPERATION_TIMEOUT
      );
      
      let positiveBalancesCount = 0;
      
      // Traiter les résultats du multicall
      for (let j = 0; j < validTokens.length; j++) {
        const token = validTokens[j];
        const balanceResult = balances[j];
        
        if (balanceResult.status === 'success' && balanceResult.result && balanceResult.result !== 0n) {
          const balanceValue = Number(balanceResult.result) / Math.pow(10, token.decimals);
          if (balanceValue > 0) {
            results.push({
              wallet: wallet,
              token: token.address,
              balance: balanceValue,
              symbol: token.symbol
            });
            positiveBalancesCount++;
          }
        }
      }
      
      // Réinitialiser le compteur d'échecs si réussite
      consecutiveRpcFailures = 0;
      
      // Stocker le résultat pour affichage à la fin
      walletResults[wallet] = positiveBalancesCount;
      
    } catch (err) {
      errors.push(`Wallet ${shortenedWallet}: ${err.message}`);
      
      // Incrémenter le compteur d'échecs
      consecutiveRpcFailures++;
      
      // En cas d'échec, tenter de changer de RPC
      const rpcSwitched = await setupWorkingRPCClient(true); // true = mode silencieux
      
      // Si impossible de trouver un RPC fonctionnel et trop d'échecs consécutifs, lancer le script de secours
      if (!rpcSwitched && consecutiveRpcFailures >= MAX_RPC_FAILURES) {
        console.warn(`⚠️ ${consecutiveRpcFailures} échecs consécutifs des RPC, lancement du script de secours...`);
        await launchBackupScript();
        return results; // Terminer ce script après avoir lancé le script de secours
      }
    }
    
    processedWallets++;
    progress.update(processedWallets, wallet, walletResults[wallet] || 0);
    
    // Petit délai entre chaque wallet pour ne pas surcharger le RPC
    await delay(500);
  }
  
  // Terminer la barre de progression
  progress.finish();
  
  // Afficher le résumé des tokens trouvés par wallet
  console.log("\n📋 Résumé des tokens trouvés par wallet:");
  let totalPositiveBalances = 0;
  
  Object.entries(walletResults).forEach(([wallet, count]) => {
    if (count > 0) {
      console.log(`  - ${wallet.substring(0, 8)}...${wallet.substring(wallet.length - 6)}: ${count} tokens`);
      totalPositiveBalances += count;
    }
  });
  
  console.log(`\n📈 Total des wallets avec balances: ${Object.values(walletResults).filter(c => c > 0).length}/${wallets.length}`);
  console.log(`📈 Total balances positives: ${totalPositiveBalances}`);
  
  // Afficher un résumé des erreurs à la fin
  if (errors.length > 0) {
    console.log("\n⚠️ Erreurs rencontrées:");
    errors.forEach((error, index) => {
      if (index < 5) { // Limiter l'affichage à 5 erreurs maximum
        console.log(`  - ${error}`);
      } else if (index === 5) {
        console.log(`  - ... et ${errors.length - 5} autres erreurs`);
      }
    });
  }
  
  return results;
}

async function storeBalances(records) {
  if (records.length === 0) {
    console.log("🚀 Aucune balance à stocker.");
    return;
  }

  try {
    const client = await pool.connect();
    try {
      // Récupération des enregistrements existants
      console.log("🔄 Récupération des enregistrements existants...");
      const existingRecordsResult = await client.query(`
        SELECT id, lower(wallet) as wallet, lower(token) as token, amount, type
        FROM token_balances
        WHERE wallet IS NOT NULL AND token IS NOT NULL AND type = 'wallet'
      `);
      
      const existingRecordsMap = new Map();
      for (const rec of existingRecordsResult.rows) {
        const key = `${rec.wallet}_${rec.token}`;
        existingRecordsMap.set(key, rec);
      }
      
      // Collecte des tokens actifs pour la suppression finale
      const activeWalletTokens = new Set();
      
      // Préparation des records à insérer ou mettre à jour
      const recordsToUpdate = [];
      const recordsToInsert = [];
      
      for (const record of records) {
        const wallet = record.wallet.toLowerCase();
        const token = record.token.toLowerCase();
        const amount = record.balance;
        const type = "wallet";
        
        // Ajouter à l'ensemble des tokens actifs
        const walletTokenKey = `${wallet}_${token}`;
        activeWalletTokens.add(walletTokenKey);
        
        const key = `${wallet}_${token}`;
        const existingRecord = existingRecordsMap.get(key);
        
        if (existingRecord) {
          // Mettre à jour l'enregistrement existant
          recordsToUpdate.push({
            id: existingRecord.id,
            wallet,
            token,
            amount,
            type
          });
          existingRecordsMap.delete(key);
        } else {
          // Insérer un nouvel enregistrement
          recordsToInsert.push({
            wallet,
            token,
            amount,
            type
          });
        }
      }
      
      // Mise à jour des records existants
      if (recordsToUpdate.length > 0) {
        console.log(`🔄 Mise à jour de ${recordsToUpdate.length} enregistrements...`);
        
        // Créer une table temporaire pour les mises à jour
        await client.query(`
          CREATE TEMP TABLE temp_balances (
            id int,
            wallet varchar(255),
            token varchar(255),
            amount decimal(20,4),
            type varchar(50)
          )
        `);
        
        // Insérer les données par lots pour éviter les limitations de paramètres
        const BATCH_SIZE = 800;
        for (let i = 0; i < recordsToUpdate.length; i += BATCH_SIZE) {
          const batch = recordsToUpdate.slice(i, i + BATCH_SIZE);
          const insertTempQuery = `
            INSERT INTO temp_balances 
            VALUES ${batch.map((_, idx) => 
              `($${idx * 5 + 1}, $${idx * 5 + 2}, $${idx * 5 + 3}, $${idx * 5 + 4}, $${idx * 5 + 5})`
            ).join(', ')}
          `;
          
          await client.query(insertTempQuery, batch.flatMap(r => [
            r.id,
            r.wallet,
            r.token,
            r.amount,
            r.type
          ]));
        }
        
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
        
        const updateResult = await client.query(updateQuery);
        
        // Nettoyer la table temporaire
        await client.query('DROP TABLE temp_balances');
      }
      
      // Insertion des nouveaux records
      if (recordsToInsert.length > 0) {
        console.log(`➕ Insertion de ${recordsToInsert.length} nouveaux enregistrements...`);
        
        // Insérer les données par lots
        const BATCH_SIZE = 100;
        for (let i = 0; i < recordsToInsert.length; i += BATCH_SIZE) {
          const batch = recordsToInsert.slice(i, i + BATCH_SIZE);
          const insertQuery = `
            INSERT INTO token_balances (wallet, token, amount, type)
            VALUES ${batch.map((_, idx) => 
              `($${idx * 4 + 1}, $${idx * 4 + 2}, $${idx * 4 + 3}, $${idx * 4 + 4})`
            ).join(', ')}
          `;
          
          const values = batch.flatMap(r => [
            r.wallet,
            r.token,
            r.amount,
            r.type
          ]);
          
          await client.query(insertQuery, values);
        }
      }
      
      // Supprimer les enregistrements qui n'existent plus
      console.log(`🔍 Recherche des enregistrements inactifs parmi ${activeWalletTokens.size} tokens actifs...`);
      
      const recordsToDelete = [];
      
      for (const [key, rec] of existingRecordsMap.entries()) {
        if (rec.type === "wallet" && !activeWalletTokens.has(key)) {
          recordsToDelete.push(rec.id);
        }
      }
      
      if (recordsToDelete.length > 0) {
        console.log(`🗑️ Suppression de ${recordsToDelete.length} enregistrements inactifs...`);
        
        // Supprimer par lots
        const BATCH_SIZE = 5000;
        for (let i = 0; i < recordsToDelete.length; i += BATCH_SIZE) {
          const batch = recordsToDelete.slice(i, i + BATCH_SIZE);
          const deleteQuery = `
            DELETE FROM token_balances
            WHERE id = ANY($1)
          `;
          
          await client.query(deleteQuery, [batch]);
        }
      } else {
        console.log("✅ Aucun enregistrement inactif à supprimer");
      }
      
      console.log(`✅ Synchronisation terminée: ${recordsToUpdate.length} mises à jour, ${recordsToInsert.length} insertions, ${recordsToDelete.length} suppressions.`);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("❌ Erreur lors du stockage des balances:", err.message);
  }
}

async function main() {
  try {
    console.log("🚀 Démarrage du script...");
    const scriptStartTime = Date.now();
    
    // Initialiser le RPC
    const rpcReady = await setupWorkingRPCClient();
    if (!rpcReady) {
      console.error("❌ Impossible de continuer sans RPC fonctionnel.");
      // Lancer le script de secours si aucun RPC n'est disponible dès le départ
      await launchBackupScript();
      return;
    }
    
    const { wallets, tokens } = await getWalletsAndTokens();
    
    if (!wallets.length || !tokens.length) {
      console.warn("⚠️ Aucun wallet ou token trouvé, arrêt du script.");
      return;
    }

    console.log(`🔍 Récupération des balances pour ${wallets.length} wallets et ${tokens.length} tokens...`);
    
    const balances = await getBalancesInBatches(wallets, tokens, scriptStartTime);
    
    console.log(`📦 Total: ${balances.length} balances récupérées.`);
    
    await storeBalances(balances);
  } catch (err) {
    console.error("❌ Erreur dans le script:", err.message);
  } finally {
    await pool.end();
  }
}

// Fonction pour tester un RPC et créer un client fonctionnel
async function setupWorkingRPCClient(silent = false) {
  if (!silent) {
    console.log("🔍 Test des RPC Gnosis disponibles...");
  }
  
  for (const rpc of RPC_ENDPOINTS) {
    try {
      if (!silent) {
        console.log(`🔄 Test du RPC ${rpc.name} (${rpc.url})...`);
      }
      
      const testClient = createPublicClient({
        chain: gnosis,
        transport: http(rpc.url, {
          timeout: 10000,
          retryCount: 1
        })
      });
      
      const blockNumber = await testClient.getBlockNumber();
      
      if (!silent) {
        console.log(`✅ RPC ${rpc.name} opérationnel (bloc actuel: ${blockNumber})`);
      }
      
      activeClient = createPublicClient({
        chain: gnosis,
        transport: http(rpc.url, {
          timeout: 10000,
          retryCount: 3,
          retryDelay: 1000
        })
      });
      
      return true;
    } catch (err) {
      if (!silent) {
        console.warn(`⚠️ RPC ${rpc.name} non disponible: ${err.message}`);
      }
    }
  }
  
  if (!silent) {
    console.error("❌ Aucun RPC disponible! Impossible de continuer.");
  }
  return false;
}

main(); 