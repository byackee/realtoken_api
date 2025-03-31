const { createPublicClient, http, createWalletClient, parseAbi } = require('viem');
const { gnosis, mainnet } = require('viem/chains');
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
const GNOSIS_RPC_ENDPOINTS = [
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

// Configuration des différents RPC pour Ethereum
const ETHEREUM_RPC_ENDPOINTS = [
  {
    name: "Ethereum PublicNode",
    url: "https://ethereum-rpc.publicnode.com"
  },
  {
    name: "Ethereum Cloudflare",
    url: "https://cloudflare-eth.com"
  },
  {
    name: "Ethereum Infura",
    url: "https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161"
  },
];

// Référence des clients disponibles globalement
let activeGnosisClient = null;
let activeEthereumClient = null;
// Compteur d'échecs consécutifs de RPC
let consecutiveRpcFailures = 0;
// Seuil d'échecs avant de lancer le script de secours
const MAX_RPC_FAILURES = 5;

// Liste des contrats problématiques à ignorer
const BLACKLISTED_CONTRACTS = [
  // Ajouter d'autres contrats problématiques ici
].map(addr => addr.toLowerCase());

// Liste dynamique des contrats problématiques découverts pendant l'exécution
const runtimeBlacklist = new Set();

// Liste des tokens avec décimales spécifiques
const TOKEN_DECIMALS = {
  '0x0675e8f4a52ea6c845cb6427af03616a2af42170': 9
};

// Fonction utilitaire pour ajouter un délai
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Fonction pour obtenir un client pour notre RPC actif
function getClient(chain = 'gnosis') {
  if (chain === 'gnosis' && !activeGnosisClient) {
    throw new Error("Aucun RPC Gnosis actif disponible!");
  }
  if (chain === 'ethereum' && !activeEthereumClient) {
    throw new Error("Aucun RPC Ethereum actif disponible!");
  }
  
  return chain === 'gnosis' ? activeGnosisClient : activeEthereumClient;
}

// Fonction pour créer une barre de progression
function createProgressBar(total, startTime, size = 30, name = '', linePosition = 0) {
  let lastProgress = -1;  // Pour éviter des mises à jour inutiles
  let initialized = false;
  
  return {
    update: (current, wallet = '', positiveBalances = 0, chain = '') => {
      const progress = Math.floor((current / total) * 100);
      const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
      
      // N'afficher que si le pourcentage a changé ou si c'est la première fois
      if (progress !== lastProgress || current === total || !initialized) {
        initialized = true;
        const filled = Math.floor((current / total) * size);
        const bar = '█'.repeat(filled) + '░'.repeat(size - filled);
        
        // Information sur le RPC, si applicable
        let rpcInfo = '';
        if (chain) {
          const client = chain === 'gnosis' ? activeGnosisClient : activeEthereumClient;
          const activeRpc = client?.transport?.url || 'Aucun RPC';
          const rpcEndpoints = chain === 'gnosis' ? GNOSIS_RPC_ENDPOINTS : ETHEREUM_RPC_ENDPOINTS;
          const rpcName = rpcEndpoints.find(rpc => rpc.url === activeRpc)?.name || 'Inconnu';
          rpcInfo = ` RPC: ${rpcName}`;
        }
        
        // Si un nom est fourni, c'est une barre nommée (globale ou par chaîne)
        const namePrefix = name ? `${name}: ` : '';
        const walletInfo = wallet ? ` Wallet: ${wallet.substring(0, 8)}` : '';
        const chainInfo = chain ? ` Chaîne: ${chain}` : '';
        
        // Construire la ligne de la barre de progression
        const progressLine = `${namePrefix}[${bar}] ${progress}% (${current}/${total}) Temps: ${elapsedSeconds}s${walletInfo}${chainInfo}${rpcInfo}`;
        
        // Positionner le curseur et effacer la ligne
        process.stdout.write(`\x1b[${linePosition};0H\x1b[K${progressLine}`);
        
        lastProgress = progress;
      }
    },
    finish: () => {
      // Ne rien faire à la fin, on garde les lignes en place
    },
    // Initialiser la ligne (afficher une ligne vide la première fois)
    init: () => {
      if (!initialized) {
        process.stdout.write(`\x1b[${linePosition};0H\x1b[K${name}: Initialisation...`);
        initialized = true;
      }
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
            ethereum_contract,
            symbol
          FROM real_tokens 
          WHERE gnosis_contract IS NOT NULL OR ethereum_contract IS NOT NULL
        `)
      ]);

      const wallets = walletsResult.rows
        .map(rec => rec.address?.toLowerCase())
        .filter(Boolean);
      
      // Traiter les tokens Gnosis
      const gnosisTokens = tokensResult.rows
        .filter(rec => rec.gnosis_contract)
        .map(rec => ({
          address: rec.gnosis_contract,
          symbol: rec.symbol || 'UNKNOWN',
          chain: 'gnosis',
          ethAddress: rec.ethereum_contract || null,
          decimals: 18 // Valeur par défaut fixe
        }))
        .filter(rec => rec.address);
      
      // Traiter les tokens Ethereum qui ne sont pas déjà sur Gnosis
      const ethereumOnlyTokens = tokensResult.rows
        .filter(rec => rec.ethereum_contract && !gnosisTokens.some(gt => 
          gt.ethAddress && gt.ethAddress.toLowerCase() === rec.ethereum_contract.toLowerCase()
        ))
        .map(rec => ({
          address: rec.ethereum_contract,
          symbol: rec.symbol || 'UNKNOWN',
          chain: 'ethereum',
          decimals: 18 // Valeur par défaut fixe
        }))
        .filter(rec => rec.address);
      
      // Combiner les tokens Gnosis et Ethereum
      const allTokens = [...gnosisTokens, ...ethereumOnlyTokens];

      console.log(`✅ ${wallets.length} wallets récupérés.`);
      console.log(`✅ ${gnosisTokens.length} tokens Gnosis et ${ethereumOnlyTokens.length} tokens Ethereum exclusifs récupérés.`);
      
      return { wallets, tokens: allTokens };
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
  
  // Séparer les tokens par chaîne
  const gnosisTokens = tokens.filter(t => t.chain === 'gnosis');
  const ethereumTokens = tokens.filter(t => t.chain === 'ethereum' || t.ethAddress);
  
  // Filtrer les tokens pour exclure les contrats blacklistés
  const validGnosisTokens = gnosisTokens.filter(token => {
    const address = token.address.toLowerCase();
    return !BLACKLISTED_CONTRACTS.includes(address) && !runtimeBlacklist.has(address);
  });
  
  const validEthereumTokens = ethereumTokens.filter(token => {
    const address = (token.chain === 'ethereum' ? token.address : token.ethAddress).toLowerCase();
    return !BLACKLISTED_CONTRACTS.includes(address) && !runtimeBlacklist.has(address);
  });
  
  console.log(`✅ ${validGnosisTokens.length}/${gnosisTokens.length} tokens Gnosis valides`);
  console.log(`✅ ${validEthereumTokens.length}/${ethereumTokens.length} tokens Ethereum valides`);
  console.log("🔍 Début du traitement des wallets...");
  
  // Préparation pour l'affichage des jauges sur des lignes différentes
  console.log("\n\n\n"); // Ajouter 3 lignes vides pour les jauges
  
  // Créer une Map pour stocker les balances temporaires avant de les combiner
  const balancesMap = new Map();
  
  // Créer des barres de progression sur des lignes différentes
  const totalRequests = wallets.length * 2; // Gnosis + Ethereum pour chaque wallet
  const globalProgress = createProgressBar(totalRequests, startTime, 30, "Global", process.stdout.rows - 3);
  const gnosisProgress = createProgressBar(wallets.length, startTime, 30, "Gnosis", process.stdout.rows - 2);
  const ethereumProgress = createProgressBar(wallets.length, startTime, 30, "Ethereum", process.stdout.rows - 1);
  
  // Initialiser les jauges
  globalProgress.init();
  gnosisProgress.init();
  ethereumProgress.init();
  
  let processedGnosis = 0;
  let processedEthereum = 0;
  let processedGlobal = 0;

  // Fonction pour traiter un wallet sur une chaîne spécifique
  async function processWalletOnChain(wallet, chain) {
    const validTokens = chain === 'gnosis' ? validGnosisTokens : validEthereumTokens;
    const shortenedWallet = wallet.substring(0, 8);
    
    try {
      // Obtenir le client approprié
      const client = getClient(chain);
      
      // Préparer les contrats pour multicall
      const contracts = chain === 'gnosis' 
        ? validTokens.map(token => ({
            address: token.address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [wallet]
          }))
        : validTokens.map(token => {
            const address = token.chain === 'ethereum' ? token.address : token.ethAddress;
            return {
              address,
              abi: erc20Abi,
              functionName: 'balanceOf',
              args: [wallet]
            };
          });
      
      // Exécuter le multicall avec timeout
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
        
        // Déterminer l'adresse du token selon la chaîne
        const tokenAddress = chain === 'gnosis' 
          ? token.address 
          : (token.chain === 'ethereum' ? token.address : token.ethAddress);
        
        if (balanceResult.status === 'success' && balanceResult.result && balanceResult.result !== 0n) {
          // Utiliser les décimales spécifiques si définies, sinon utiliser les décimales par défaut
          const decimals = TOKEN_DECIMALS[tokenAddress.toLowerCase()] || token.decimals;
          const balanceValue = Number(balanceResult.result) / Math.pow(10, decimals);
          
          if (balanceValue > 0) {
            // Gérer les tokens Ethereum qui correspondent à des tokens Gnosis
            if (chain === 'ethereum' && token.chain === 'gnosis') {
              const gnosisKey = `${wallet}_${token.address}_gnosis`;
              if (balancesMap.has(gnosisKey)) {
                // Combiner la balance avec celle de Gnosis
                const gnosisBalance = balancesMap.get(gnosisKey);
                gnosisBalance.balance += balanceValue;
                balancesMap.set(gnosisKey, gnosisBalance);
              }
            } else {
              // Token régulier - stocker normalement
              const key = `${wallet}_${tokenAddress}_${chain}`;
              balancesMap.set(key, {
                wallet: wallet,
                token: tokenAddress,
                balance: balanceValue,
                symbol: token.symbol,
                chain: chain,
                ethToken: chain === 'gnosis' ? token.ethAddress : null
              });
              positiveBalancesCount++;
            }
          }
        }
      }
      
      // Réinitialiser le compteur d'échecs si réussite
      consecutiveRpcFailures = 0;
      
      // Stocker le résultat pour affichage à la fin
      walletResults[`${wallet}_${chain}`] = positiveBalancesCount;
      
      return { success: true, chain, wallet, positiveBalancesCount };
    } catch (err) {
      errors.push(`Wallet ${shortenedWallet} (${chain}): ${err.message}`);
      
      // Incrémenter le compteur d'échecs
      consecutiveRpcFailures++;
      
      // En cas d'échec, tenter de changer de RPC
      const rpcSwitched = await setupWorkingRPCClient(chain, true); // true = mode silencieux
      
      // Si impossible de trouver un RPC fonctionnel et trop d'échecs consécutifs, lancer le script de secours
      if (!rpcSwitched && consecutiveRpcFailures >= MAX_RPC_FAILURES) {
        console.warn(`⚠️ ${consecutiveRpcFailures} échecs consécutifs des RPC, lancement du script de secours...`);
        await launchBackupScript();
        return { success: false, shouldExit: true };
      }
      
      return { success: false, chain, wallet };
    }
  }

  // Revenir à un traitement plus séquentiel pour de meilleures performances
  // D'abord tous les wallets sur Gnosis, puis tous sur Ethereum
  
  // 1. Traiter tous les wallets sur Gnosis
  try {
    console.log("⛓️ Traitement des wallets sur Gnosis...");
    
    for (let w = 0; w < wallets.length; w++) {
      const wallet = wallets[w];
      
      const result = await processWalletOnChain(wallet, 'gnosis');
      
      if (result.shouldExit) {
        // Si on doit quitter, arrêter tout
        return Array.from(balancesMap.values());
      }
      
      processedGnosis++;
      gnosisProgress.update(processedGnosis, wallet, result.positiveBalancesCount || 0, 'gnosis');
      
      processedGlobal++;
      globalProgress.update(processedGlobal, wallet);
      
      // Petit délai pour éviter de surcharger le RPC
      await delay(100);
    }
    
    // 2. Traiter tous les wallets sur Ethereum
    console.log("⛓️ Traitement des wallets sur Ethereum...");
    
    for (let w = 0; w < wallets.length; w++) {
      const wallet = wallets[w];
      
      const result = await processWalletOnChain(wallet, 'ethereum');
      
      if (result.shouldExit) {
        // Si on doit quitter, arrêter tout
        return Array.from(balancesMap.values());
      }
      
      processedEthereum++;
      ethereumProgress.update(processedEthereum, wallet, result.positiveBalancesCount || 0, 'ethereum');
      
      processedGlobal++;
      globalProgress.update(processedGlobal, wallet);
      
      // Petit délai pour éviter de surcharger le RPC
      await delay(100);
    }
  } catch (err) {
    console.error(`❌ Erreur lors du traitement: ${err.message}`);
    // En cas d'erreur globale, retourner les résultats déjà collectés
  }
  
  // Ajouter des lignes après les jauges pour ne pas écraser leur affichage
  process.stdout.write("\n\n\n");
  
  // Convertir la map en tableau de résultats
  const combinedResults = Array.from(balancesMap.values());
  
  // Afficher le résumé des tokens trouvés par wallet
  console.log("\n📋 Résumé des tokens trouvés par wallet:");
  let totalPositiveBalances = 0;
  
  for (const wallet of wallets) {
    const gnosisCount = walletResults[`${wallet}_gnosis`] || 0;
    const ethereumCount = walletResults[`${wallet}_ethereum`] || 0;
    const totalCount = gnosisCount + ethereumCount;
    
    if (totalCount > 0) {
      console.log(`  - ${wallet.substring(0, 8)}...${wallet.substring(wallet.length - 6)}: ${totalCount} tokens (Gnosis: ${gnosisCount}, Ethereum: ${ethereumCount})`);
      totalPositiveBalances += totalCount;
    }
  }
  
  console.log(`\n📈 Total des wallets avec balances: ${wallets.filter(w => 
    (walletResults[`${w}_gnosis`] || 0) + (walletResults[`${w}_ethereum`] || 0) > 0
  ).length}/${wallets.length}`);
  console.log(`📈 Total balances positives: ${combinedResults.length}`);
  
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
  
  return combinedResults;
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
    
    // Initialiser les RPC
    const gnosisRpcReady = await setupWorkingRPCClient('gnosis');
    const ethereumRpcReady = await setupWorkingRPCClient('ethereum');
    
    if (!gnosisRpcReady || !ethereumRpcReady) {
      console.error("❌ Impossible de continuer sans RPC fonctionnels.");
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
async function setupWorkingRPCClient(chain = 'gnosis', silent = false) {
  const endpoints = chain === 'gnosis' ? GNOSIS_RPC_ENDPOINTS : ETHEREUM_RPC_ENDPOINTS;
  const chainObj = chain === 'gnosis' ? gnosis : mainnet;
  
  if (!silent) {
    console.log(`🔍 Test des RPC ${chain} disponibles...`);
  }
  
  for (const rpc of endpoints) {
    try {
      if (!silent) {
        console.log(`🔄 Test du RPC ${rpc.name} (${rpc.url})...`);
      }
      
      const testClient = createPublicClient({
        chain: chainObj,
        transport: http(rpc.url, {
          timeout: 10000,
          retryCount: 1
        })
      });
      
      const blockNumber = await testClient.getBlockNumber();
      
      if (!silent) {
        console.log(`✅ RPC ${rpc.name} opérationnel (bloc actuel: ${blockNumber})`);
      }
      
      const client = createPublicClient({
        chain: chainObj,
        transport: http(rpc.url, {
          timeout: 10000,
          retryCount: 3,
          retryDelay: 1000
        })
      });
      
      if (chain === 'gnosis') {
        activeGnosisClient = client;
      } else {
        activeEthereumClient = client;
      }
      
      return true;
    } catch (err) {
      if (!silent) {
        console.warn(`⚠️ RPC ${rpc.name} non disponible: ${err.message}`);
      }
    }
  }
  
  if (!silent) {
    console.error(`❌ Aucun RPC ${chain} disponible! Impossible de continuer.`);
  }
  return false;
}

main(); 