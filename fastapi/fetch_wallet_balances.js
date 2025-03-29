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

// Configuration du client Viem pour Gnosis - Utiliser uniquement le RPC local
const GNOSIS_RPC_URL = 'http://gnosis-node:8545';

// Fonction pour obtenir un client pour notre RPC local
function getClient() {
  return createPublicClient({
    chain: gnosis,
    transport: http(GNOSIS_RPC_URL, {
      timeout: 15000,
      retryCount: 2,
      retryDelay: 1000
    })
  });
}

// Client par défaut (utilisé pour les requêtes isolées)
const client = getClient();

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

// Fonction pour créer une barre de progression
function createProgressBar(total, size = 30) {
  let lastProgress = -1;  // Pour éviter des mises à jour inutiles
  
  return {
    update: (current) => {
      const progress = Math.floor((current / total) * 100);
      
      // N'afficher que si le pourcentage a changé
      if (progress !== lastProgress) {
        const filled = Math.floor((current / total) * size);
        const bar = '█'.repeat(filled) + '░'.repeat(size - filled);
        process.stdout.write(`\r[${bar}] ${progress}% (${current}/${total})`);
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
        await delay(1000 * attempt);
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

async function getBalancesInBatches(wallets, tokens) {
  const WALLET_BATCH_SIZE = 6; // Traiter 6 wallets en parallèle
  const results = [];
  const OPERATION_TIMEOUT = 30000; // 30 secondes pour le traitement complet
  const errors = []; // Stocker les erreurs pour le résumé final
  
  // Filtrer les tokens pour exclure les contrats blacklistés
  const validTokens = tokens.filter(token => {
    const address = token.address.toLowerCase();
    return !BLACKLISTED_CONTRACTS.includes(address) && !runtimeBlacklist.has(address);
  });
  
  console.log(`✅ ${validTokens.length}/${tokens.length} tokens valides`);
  
  // Créer un nombre limité de clients pour répartir les requêtes
  const clients = Array(WALLET_BATCH_SIZE).fill().map(() => getClient());
  
  // Créer une barre de progression
  const totalWallets = wallets.length;
  const progress = createProgressBar(totalWallets);
  let processedWallets = 0;
  
  // Traiter les wallets par lots
  for (let w = 0; w < wallets.length; w += WALLET_BATCH_SIZE) {
    const walletBatch = wallets.slice(w, w + WALLET_BATCH_SIZE);
    progress.update(processedWallets);
    
    // Tableau des promesses pour chaque wallet
    const walletPromises = walletBatch.map(async (wallet, walletIndex) => {
      const walletResults = [];
      const shortenedWallet = wallet.substring(0, 8);
      
      try {
        // Préparer les contrats pour multicall - tous les tokens en une seule fois
        const contracts = validTokens.map(token => ({
          address: token.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [wallet]
        }));
        
        // Exécuter le multicall avec retry
        const balances = await withRetry(async () => {
          return await withTimeout(
            clients[walletIndex].multicall({
              contracts,
              allowFailure: true,
            }),
            OPERATION_TIMEOUT
          );
        }, 1); // 1 retry = 2 tentatives au total
        
        let positiveBalancesCount = 0;
        
        // Traiter les résultats du multicall
        for (let j = 0; j < validTokens.length; j++) {
          const token = validTokens[j];
          const balanceResult = balances[j];
          
          if (balanceResult.status === 'success' && balanceResult.result && balanceResult.result !== '0x0') {
            const balanceValue = Number(balanceResult.result) / Math.pow(10, token.decimals);
            if (balanceValue > 0) {
              walletResults.push({
                wallet: wallet,
                token: token.address,
                balance: balanceValue,
                symbol: token.symbol
              });
              positiveBalancesCount++;
            }
          }
        }
      } catch (err) {
        // Stratégie de repli en cas d'échec
        errors.push(`Wallet ${shortenedWallet}: Erreur multicall`);
        
        // Diviser en 5 batches pour réessayer
        const batchSize = Math.ceil(validTokens.length / 5);
        let successCount = 0;
        
        for (let i = 0; i < validTokens.length; i += batchSize) {
          const batchTokens = validTokens.slice(i, i + batchSize);
          const batchNum = Math.floor(i/batchSize) + 1;
          
          try {
            // Préparer les contrats pour multicall
            const contracts = batchTokens.map(token => ({
              address: token.address,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [wallet]
            }));
            
            // Multicall sur le batch
            const balances = await withTimeout(
              clients[walletIndex].multicall({
                contracts,
                allowFailure: true,
              }),
              OPERATION_TIMEOUT / 2
            );
            
            // Traiter les résultats du multicall
            for (let j = 0; j < batchTokens.length; j++) {
              const token = batchTokens[j];
              const balanceResult = balances[j];
              
              if (balanceResult.status === 'success' && balanceResult.result && balanceResult.result !== '0x0') {
                const balanceValue = Number(balanceResult.result) / Math.pow(10, token.decimals);
                if (balanceValue > 0) {
                  walletResults.push({
                    wallet: wallet,
                    token: token.address,
                    balance: balanceValue,
                    symbol: token.symbol
                  });
                  successCount++;
                }
              }
            }
          } catch (batchErr) {
            // En cas d'échec du batch, on essaie les appels individuels sur un échantillon
            errors.push(`Wallet ${shortenedWallet}, batch ${batchNum}: Erreur batch`);
            const sampleTokens = batchTokens.slice(0, 30);
            
            for (const token of sampleTokens) {
              try {
                const balance = await withTimeout(
                  clients[walletIndex].readContract({
                    address: token.address,
                    abi: erc20Abi,
                    functionName: 'balanceOf',
                    args: [wallet]
                  }),
                  8000
                );
                
                if (balance && balance !== '0x0') {
                  const balanceValue = Number(balance) / Math.pow(10, token.decimals);
                  if (balanceValue > 0) {
                    walletResults.push({
                      wallet: wallet,
                      token: token.address,
                      balance: balanceValue,
                      symbol: token.symbol
                    });
                    successCount++;
                  }
                }
              } catch (tokenErr) {
                // Ignorer les erreurs individuelles
              }
              await delay(50);
            }
          }
          
          await delay(500);
        }
      }
      
      return walletResults;
    });
    
    // Attendre que tous les wallets du lot soient traités
    try {
      const batchResults = await Promise.all(walletPromises);
      // Ajouter les résultats de ce lot au tableau principal
      batchResults.forEach(walletResult => results.push(...walletResult));
      
      // Mettre à jour le compteur de wallets traités
      processedWallets += walletBatch.length;
      progress.update(processedWallets);
    } catch (err) {
      errors.push(`Erreur lors du traitement parallèle: ${err.message}`);
      processedWallets += walletBatch.length;
      progress.update(processedWallets);
    }
    
    await delay(2000);
  }
  
  // Terminer la barre de progression
  progress.finish();
  
  // Afficher un résumé des erreurs à la fin
  if (errors.length > 0) {
    console.log("\n📋 Résumé des erreurs:");
    errors.forEach((error, index) => {
      console.log(`  ${index + 1}. ${error}`);
    });
  }
  
  console.log(`📈 Total balances: ${results.length}`);
  
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
        WHERE wallet IS NOT NULL AND token IS NOT NULL
      `);
      
      const existingRecordsMap = new Map();
      for (const rec of existingRecordsResult.rows) {
        const key = `${rec.wallet}_${rec.token}`;
        existingRecordsMap.set(key, rec);
      }
      
      // Préparation des records à insérer ou mettre à jour
      const recordsToUpdate = [];
      const recordsToInsert = [];
      
      for (const record of records) {
        const wallet = record.wallet.toLowerCase();
        const token = record.token.toLowerCase();
        const amount = record.balance;
        const type = "wallet"; // Type par défaut comme dans l'ancien script
        
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
      
      console.log(`✅ Synchronisation terminée: ${recordsToUpdate.length} mises à jour, ${recordsToInsert.length} insertions.`);
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
    const { wallets, tokens } = await getWalletsAndTokens();
    
    if (!wallets.length || !tokens.length) {
      console.warn("⚠️ Aucun wallet ou token trouvé, arrêt du script.");
      return;
    }

    console.log(`🔍 Récupération des balances pour ${wallets.length} wallets et ${tokens.length} tokens...`);
    
    const balances = await getBalancesInBatches(wallets, tokens);
    
    console.log(`📦 Total: ${balances.length} balances récupérées.`);
    
    await storeBalances(balances);
  } catch (err) {
    console.error("❌ Erreur dans le script:", err.message);
  } finally {
    await pool.end();
  }
}

main(); 